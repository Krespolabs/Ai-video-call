// Pole Club tip-sweep — finds unpaid `club_tips` rows, groups by
// (dancer, network, asset), and sends one on-chain USDC transfer per group
// to the dancer's registered wallet. Idempotent on retry: only rows with
// paid_at IS NULL are eligible, and rows are claimed before the send goes
// out so a crash between send and commit can never double-spend.
//
// Called from api/cron/[name].js#handleClubPayouts.

import { randomUUID } from 'node:crypto';

import { sql } from '../db.js';
import { sendClubPayout } from './payouts.js';
import { chainOf } from './chain.js';
import { SOLANA_USDC_MINT, EVM_USDC } from '../../payments/_config.js';

// Below this total (per dancer × network), don't sweep — the fee dwarfs the
// tip. 5000 atomics == 0.005 USDC (6 decimals). Configurable via env for ops
// who want to tune cadence vs amortization without a redeploy.
export const DUST_THRESHOLD_ATOMICS = BigInt(
	process.env.CLUB_SWEEP_DUST_ATOMICS || '5000',
);

const BASE_USDC = EVM_USDC[8453]; // Base mainnet contract address

/**
 * Sync dancer wallet addresses from env vars on each cron tick, so ops can
 * roll new addresses purely via Vercel env without touching the DB. Env
 * names map 1:1 to the dancer slot ('1'..'4'):
 *   CLUB_DANCER_EVM_1, CLUB_DANCER_SOL_1, CLUB_DANCER_EVM_2, ...
 *
 * Values are only written when the row currently has NULL on that column.
 * The admin endpoint takes precedence — once an admin sets an address it
 * sticks, even if the env var changes later.
 */
async function syncDancerWalletsFromEnv() {
	const rows = await sql`
		select dancer, evm_address, solana_address from club_dancer_wallets
	`;
	for (const row of rows) {
		const evmEnv = process.env[`CLUB_DANCER_EVM_${row.dancer}`];
		const solEnv = process.env[`CLUB_DANCER_SOL_${row.dancer}`];
		if (!row.evm_address && evmEnv) {
			await sql`
				update club_dancer_wallets
				set evm_address = ${evmEnv}, updated_at = now()
				where dancer = ${row.dancer} and evm_address is null
			`;
		}
		if (!row.solana_address && solEnv) {
			await sql`
				update club_dancer_wallets
				set solana_address = ${solEnv}, updated_at = now()
				where dancer = ${row.dancer} and solana_address is null
			`;
		}
	}
}

/**
 * Run one sweep cycle. Returns a summary suitable for cron logs.
 *
 * @param {object} [opts]
 * @param {(group: object) => Promise<{signature: string, network: string, amount_atomics: string}>} [opts.send]
 *        Override the payout sender for tests. Defaults to the real on-chain
 *        sendClubPayout from ./payouts.js.
 */
export async function runClubPayoutSweep({ send = sendClubPayout } = {}) {
	await syncDancerWalletsFromEnv();

	const groups = await sql`
		select
			d.dancer,
			d.display_name,
			d.evm_address,
			d.solana_address,
			t.network,
			t.asset,
			array_agg(t.id) as tip_ids,
			sum(t.amount_atomics)::text as total_atomics,
			count(t.*)::int as tip_count,
			min(t.created_at) as oldest_tip
		from club_tips t
		join club_dancer_wallets d on d.dancer = t.dancer
		where t.paid_at is null
		group by d.dancer, d.display_name, d.evm_address, d.solana_address, t.network, t.asset
		having sum(t.amount_atomics) >= ${DUST_THRESHOLD_ATOMICS.toString()}::numeric
		order by d.dancer asc, t.network asc
	`;

	const summary = {
		groups_considered: groups.length,
		paid: [],
		skipped: [],
		errored: [],
		total_atomics_sent: '0',
	};

	let totalSent = 0n;

	for (const group of groups) {
		// Collapse the stored CAIP-2 network ('solana:5eykt4…' / 'eip155:8453'
		// from a settled x402 tip) or bare chain key ('solana' / 'base' from a
		// bypass ticket) to the chain the senders + wallet columns are keyed on.
		// Without this every settled Solana tip falls through to the EVM branch
		// below and is skipped as "no wallet" even with a Solana address set.
		const network = chainOf(group.network);
		const recipient = network === 'solana' ? group.solana_address : group.evm_address;
		const tipIds = group.tip_ids;
		const totalAtomics = BigInt(group.total_atomics);
		const expectedAsset = network === 'solana' ? SOLANA_USDC_MINT : BASE_USDC;

		if (!recipient) {
			summary.skipped.push({
				dancer: group.dancer,
				network,
				reason: 'no_wallet',
				tip_count: tipIds.length,
			});
			// A dancer who simply hasn't onboarded a payout wallet is an
			// expected steady state — tips stay unpaid and sweep the moment a
			// wallet is registered, so don't escalate to a warning every tick
			// (that buries real warnings). Only warn once the oldest tip has
			// been stuck long enough that ops should chase a wallet.
			const oldestMs = group.oldest_tip ? new Date(group.oldest_tip).getTime() : NaN;
			const stuckHours = Number.isFinite(oldestMs) ? (Date.now() - oldestMs) / 3_600_000 : 0;
			const msg = `[club-payouts] no ${network} wallet for dancer ${group.dancer} — skipping ${tipIds.length} tips`;
			if (stuckHours >= 24) {
				// Warn at most once per 24-hour period — this cron runs every 5 minutes so
				// without the gate the same message would log ~288 times a day per dancer.
				// Detect boundary crossing: floor(stuckHours/24) increments exactly once
				// each day regardless of cron jitter.
				const CRON_INTERVAL_H = 5 / 60;
				const dayNow = Math.floor(stuckHours / 24);
				const dayPrior = Math.floor((stuckHours - CRON_INTERVAL_H) / 24);
				if (dayNow > dayPrior) {
					console.warn(`${msg} (oldest unpaid ${Math.round(stuckHours)}h ago — register a payout wallet)`);
				}
			} else {
				console.info(msg);
			}
			continue;
		}
		if (expectedAsset && group.asset && group.asset !== expectedAsset) {
			// Defensive: refuse to send if tips reference an asset other than
			// USDC. Should never happen with the current tip endpoint, but
			// it's cheap insurance against a future regression.
			summary.skipped.push({
				dancer: group.dancer,
				network,
				reason: 'asset_mismatch',
				asset: group.asset,
			});
			console.warn(`[club-payouts] asset mismatch for dancer ${group.dancer} on ${network}: ${group.asset}`);
			continue;
		}

		const claimToken = `PENDING-${randomUUID()}`;

		// Claim before send: anyone who races us (another cron, retry) will
		// see paid_at non-null on these rows and skip them. If we crash
		// between claim and confirm, the rows stay claimed until the next
		// invocation observes the lack of a ledger row and rolls them back
		// (handled at the top of the cron via expirePendingClaims).
		const claimed = await sql`
			update club_tips
			set paid_at = now(), paid_tx = ${claimToken}
			where id = any(${tipIds})
			  and paid_at is null
			returning id
		`;
		if (claimed.length === 0) {
			// Another sweep already grabbed them — nothing to do.
			summary.skipped.push({
				dancer: group.dancer,
				network,
				reason: 'already_claimed',
			});
			continue;
		}
		if (claimed.length !== tipIds.length) {
			// Partial overlap — recompute the sum from what we actually
			// hold so we don't over-send.
			const [recount] = await sql`
				select coalesce(sum(amount_atomics), 0)::text as total
				from club_tips
				where id = any(${claimed.map((r) => r.id)})
			`;
			const realAtomics = BigInt(recount?.total || '0');
			if (realAtomics < DUST_THRESHOLD_ATOMICS) {
				// Whatever's left no longer clears the dust gate. Release.
				await sql`
					update club_tips
					set paid_at = null, paid_tx = null
					where id = any(${claimed.map((r) => r.id)}) and paid_tx = ${claimToken}
				`;
				summary.skipped.push({
					dancer: group.dancer,
					network,
					reason: 'partial_below_dust',
				});
				continue;
			}
		}
		const claimedIds = claimed.map((r) => r.id);
		const [recount] = await sql`
			select coalesce(sum(amount_atomics), 0)::text as total
			from club_tips
			where id = any(${claimedIds})
		`;
		const sendAmount = BigInt(recount?.total || totalAtomics.toString());

		try {
			const result = await send({
				network,
				recipient,
				amount: sendAmount,
			});

			await sql`
				insert into club_payouts
					(dancer, network, asset, amount_atomics, tx, swept_tip_count)
				values
					(${group.dancer}, ${network}, ${group.asset}, ${sendAmount.toString()},
					 ${result.signature}, ${claimedIds.length})
			`;
			await sql`
				update club_tips
				set paid_tx = ${result.signature}
				where id = any(${claimedIds}) and paid_tx = ${claimToken}
			`;

			totalSent += sendAmount;
			summary.paid.push({
				dancer: group.dancer,
				display_name: group.display_name,
				network,
				amount_atomics: sendAmount.toString(),
				tx: result.signature,
				tip_count: claimedIds.length,
			});
		} catch (err) {
			// Roll back the claim so the next cron cycle retries.
			try {
				await sql`
					update club_tips
					set paid_at = null, paid_tx = null
					where id = any(${claimedIds}) and paid_tx = ${claimToken}
				`;
			} catch (revertErr) {
				console.error(
					`[club-payouts] FAILED to roll back claim for dancer ${group.dancer} on ${network} after send error`,
					revertErr,
				);
			}
			console.error(
				`[club-payouts] send failed for dancer ${group.dancer} on ${network}:`,
				err?.message || err,
			);
			summary.errored.push({
				dancer: group.dancer,
				network,
				error: String(err?.message || err).slice(0, 500),
				tip_count: claimedIds.length,
			});
		}
	}

	summary.total_atomics_sent = totalSent.toString();
	return summary;
}

/**
 * Optional pre-pass: release any rows still bearing a PENDING-* claim from
 * a prior crash older than 10 minutes. Without this, a cron crash mid-send
 * would orphan rows forever (paid_at set but no ledger row). Safe because
 * a successful send always replaces paid_tx with the real signature within
 * its single cron invocation; any leftover PENDING-* means that invocation
 * crashed.
 */
export async function expireStaleClaims() {
	await sql`
		update club_tips
		set paid_at = null, paid_tx = null
		where paid_tx like 'PENDING-%'
		  and paid_at < now() - interval '10 minutes'
	`;
}
