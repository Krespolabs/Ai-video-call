// @ts-check
// The capped, disarmed $THREE payout leg shared by the rug softener and the
// early-leader program (docs/growth-programs.md).
//
// Both programs end the same way: a set of committed payouts in
// growth_program_payouts, each worth a USD amount, that should become real
// $THREE transfers. This module is the only place that transfer happens, and
// it refuses unless every one of these holds:
//
//   1. The program's arm flag is exactly "1"/"true" (config.js). Unset means a
//      dry run: the plan is computed and returned, nothing is written or sent.
//   2. The dedicated payout key is configured: THREE_PRIZE_PAYOUT_KEY, the key
//      the Arena prize rail pays from (resolved by tournament-settlement.js), so
//      there is one funded $THREE payout wallet to watch, not three. The prize
//      rail's fallback to the club treasury secret is NOT taken here: in
//      production that secret is the economy master wallet.
//   3. The recipient is a valid Solana address and not a platform wallet
//      (treasury, rewards pool, or the payout key itself).
//   4. The payout fits under the program's rolling per-period USD cap, summed
//      over every row already 'sending' or 'sent' in the period.
//
// A row is moved to 'sending' with a compare-and-set BEFORE the transfer, so
// two overlapping ticks can never pay it twice, and a crash mid-transfer leaves
// it in 'sending' for a human to reconcile against the chain rather than
// retrying into a double payment.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { sql as defaultSql } from '../db.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LOCK_TTL_S = 300;

/**
 * Take payouts in order while they fit under the remaining cap. PURE.
 * An item that does not fit stops the walk (it is not skipped for a smaller
 * one behind it), so the queue stays first-come-first-served.
 *
 * @template {{ usd_value: number|string }} T
 * @param {T[]} items
 * @param {number} remainingUsd
 * @returns {{ fits: T[], deferred: T[] }}
 */
export function takeWithinCap(items, remainingUsd) {
	const fits = [];
	let left = Math.max(0, Number(remainingUsd) || 0);
	let i = 0;
	for (; i < items.length; i++) {
		const usd = Number(items[i].usd_value) || 0;
		if (usd > left + 1e-9) break;
		fits.push(items[i]);
		left -= usd;
	}
	return { fits, deferred: items.slice(i) };
}

/**
 * Why a single payout must not be sent, or null. PURE.
 * @param {{ recipient_wallet?: string|null, usd_value?: number|string }} row
 * @param {Set<string>} platformWallets
 */
export function rowBlockReason(row, platformWallets) {
	const w = String(row?.recipient_wallet || '');
	if (!BASE58_RE.test(w)) return 'invalid_wallet';
	if (platformWallets.has(w)) return 'platform_wallet';
	if (!(Number(row?.usd_value) > 0)) return 'zero_amount';
	return null;
}

/**
 * Convert a USD value to $THREE atomics at a price. PURE.
 * @param {number} usd
 * @param {number} priceUsd  USD per whole $THREE
 * @param {bigint} atomicsPerToken
 */
export function usdToAtomics(usd, priceUsd, atomicsPerToken) {
	if (!(usd > 0) || !(priceUsd > 0)) return 0n;
	const tokens = usd / priceUsd;
	const scaled = Math.floor(tokens * Number(atomicsPerToken));
	return Number.isFinite(scaled) && scaled > 0 ? BigInt(scaled) : 0n;
}

/** Rolling-window USD already committed (sending or sent) for a program. */
export async function periodSpentUsd(program, hours, sql = defaultSql) {
	const [row] = await sql`
		select coalesce(sum(usd_value), 0)::float as usd
		from growth_program_payouts
		where program = ${program}
		  and status in ('sending', 'sent')
		  and coalesce(sent_at, updated_at) >= now() - make_interval(hours => ${hours})
	`;
	return Number(row?.usd) || 0;
}

async function acquireLock(key, sql) {
	const rows = await sql`
		insert into app_settings (key, value)
		values (${key}, jsonb_build_object('until', extract(epoch from now()) + ${LOCK_TTL_S}))
		on conflict (key) do update
			set value = excluded.value, updated_at = now()
			where (app_settings.value->>'until')::numeric < extract(epoch from now())
		returning key
	`;
	return rows.length > 0;
}

async function releaseLock(key, sql) {
	await sql`update app_settings set value = '{"until":0}'::jsonb, updated_at = now() where key = ${key}`;
}

/** Public key of a Base58 64-byte secret, or null. */
function pubkeyOf(secretB58) {
	try {
		return Keypair.fromSecretKey(bs58.decode(secretB58)).publicKey.toBase58();
	} catch {
		return null;
	}
}

/**
 * Real dependencies, loaded lazily so a disarmed tick never even imports the
 * signing stack.
 */
async function defaultDeps() {
	const [{ resolvePrizeKeyBase58 }, { transferSplTokenChecked }, price, tokenCfg] = await Promise.all([
		import('../tournament-settlement.js'),
		import('../solana-transfer.js'),
		import('../token/price.js'),
		import('../token/config.js'),
	]);
	return {
		// Dedicated key only: the prize rail's club-treasury fallback is the
		// economy master wallet in production, which these programs must never spend.
		payoutKey: () => resolvePrizeKeyBase58({ dedicatedOnly: true }),
		price: () => price.getTokenPriceUsd({ fresh: true }),
		transfer: transferSplTokenChecked,
		mint: tokenCfg.TOKEN_MINT,
		decimals: tokenCfg.TOKEN_DECIMALS,
		atomicsPerToken: tokenCfg.ATOMICS_PER_TOKEN,
		platformWallets: [tokenCfg.treasuryWalletOrNull(), tokenCfg.rewardsWalletOrNull()].filter(Boolean),
	};
}

/**
 * Pay a program's committed queue, within its cap, if and only if it is armed.
 *
 * @param {object} p
 * @param {'rug_softener'|'early_leader'} p.program
 * @param {boolean} p.enabled        the arm flag, already resolved
 * @param {string} p.flag            the flag's env name, for the report
 * @param {number} p.capUsd          rolling cap for the period
 * @param {number} p.periodHours     the cap's window
 * @param {number} [p.limit]         rows per tick
 * @param {object} [p.deps]          injected dependencies (tests)
 * @param {Function} [p.sql]
 */
export async function runPayoutQueue({ program, enabled, flag, capUsd, periodHours, limit = 20, deps = null, sql = defaultSql }) {
	const queue = await sql`
		select id, subject_key, user_id, agent_id, position_id, recipient_wallet,
		       usd_value::float as usd_value, status, created_at
		from growth_program_payouts
		where program = ${program} and status in ('claimed', 'failed')
		order by created_at asc
		limit ${limit}
	`;
	const spent = await periodSpentUsd(program, periodHours, sql);
	const remaining = Math.max(0, capUsd - spent);
	const { fits, deferred } = takeWithinCap(queue, remaining);
	const cap = { cap_usd: capUsd, period_hours: periodHours, spent_usd: round2(spent), remaining_usd: round2(remaining) };

	if (!enabled) {
		// The disarmed path: report exactly what an armed tick would attempt, and
		// touch nothing. No lock, no status change, no signing import.
		return {
			program,
			armed: false,
			executed: false,
			reason: `${flag} is not set, so nothing is sent`,
			cap,
			queued: queue.length,
			would_pay: fits.map(shapeRow),
			deferred_by_cap: deferred.map(shapeRow),
		};
	}

	const d = deps || (await defaultDeps());
	const key = d.payoutKey();
	if (!key) {
		return {
			program,
			armed: true,
			executed: false,
			reason: 'payout_unconfigured: set THREE_PRIZE_PAYOUT_KEY (Base58 64-byte secret holding $THREE)',
			cap,
			queued: queue.length,
			would_pay: fits.map(shapeRow),
			deferred_by_cap: deferred.map(shapeRow),
		};
	}

	const lockKey = `growth_payout_lock:${program}`;
	if (!(await acquireLock(lockKey, sql))) {
		return { program, armed: true, executed: false, reason: 'another tick holds the payout lock', cap };
	}

	const results = [];
	try {
		const platform = new Set([...(d.platformWallets || []), pubkeyOf(key)].filter(Boolean));
		// One live price per tick. A payout never proceeds on a guessed price:
		// getTokenPriceUsd throws when no feed answers, which ends the tick with
		// every row still queued.
		const quote = await d.price();
		const priceUsd = Number(quote?.priceUsd);
		if (!(priceUsd > 0)) throw new Error('no live $THREE price');

		// Re-check the cap inside the lock: another tick may have paid since the
		// read above.
		let left = Math.max(0, capUsd - (await periodSpentUsd(program, periodHours, sql)));

		for (const row of fits) {
			const blocked = rowBlockReason(row, platform);
			if (blocked) {
				await sql`
					update growth_program_payouts set status = 'blocked', note = ${blocked}, updated_at = now()
					where id = ${row.id} and status in ('claimed', 'failed')
				`;
				results.push({ ...shapeRow(row), status: 'blocked', reason: blocked });
				continue;
			}
			if (row.usd_value > left + 1e-9) {
				results.push({ ...shapeRow(row), status: 'deferred', reason: 'period_cap' });
				break;
			}
			const atomics = usdToAtomics(row.usd_value, priceUsd, d.atomicsPerToken);
			if (atomics <= 0n) {
				results.push({ ...shapeRow(row), status: 'deferred', reason: 'rounds_to_zero' });
				continue;
			}

			const claimed = await sql`
				update growth_program_payouts
				set status = 'sending', amount_atomics = ${atomics.toString()}, price_usd = ${priceUsd},
				    price_source = ${quote.source || null}, updated_at = now()
				where id = ${row.id} and status in ('claimed', 'failed')
				returning id
			`;
			if (!claimed.length) continue; // someone else moved it; never pay twice
			left -= row.usd_value;

			try {
				const tx = await d.transfer({
					fromWallet: key,
					toAddress: row.recipient_wallet,
					amount: atomics,
					mint: d.mint,
					decimals: d.decimals,
				});
				await sql`
					update growth_program_payouts
					set status = 'sent', tx_signature = ${tx}, sent_at = now(), note = null, updated_at = now()
					where id = ${row.id}
				`;
				results.push({ ...shapeRow(row), status: 'sent', tx, amount_atomics: atomics.toString() });
			} catch (err) {
				const note = `transfer failed: ${String(err?.message || err).slice(0, 300)}`;
				await sql`
					update growth_program_payouts set status = 'failed', note = ${note}, updated_at = now()
					where id = ${row.id}
				`;
				left += row.usd_value; // a failed send spent nothing
				results.push({ ...shapeRow(row), status: 'failed', reason: note });
			}
		}
		return { program, armed: true, executed: true, cap, price_usd: priceUsd, results, deferred_by_cap: deferred.map(shapeRow) };
	} finally {
		await releaseLock(lockKey, sql).catch(() => {});
	}
}

function round2(x) {
	return Math.round(x * 100) / 100;
}

function shapeRow(r) {
	return {
		id: r.id,
		subject: r.subject_key,
		user_id: r.user_id || null,
		agent_id: r.agent_id || null,
		recipient_wallet: r.recipient_wallet,
		usd_value: round2(Number(r.usd_value) || 0),
	};
}
