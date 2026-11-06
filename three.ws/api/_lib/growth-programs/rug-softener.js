// @ts-check
// First-rug softener (roadmap 917, 12.15): an optional $THREE pool that pays
// back part of a first-timer's first rug, as a welcome guarantee.
//
// The abuse surface is the whole design problem, so eligibility is tight and
// every criterion is derived from real records, never from what a claimant
// says:
//
//   first trade     the claim is against the account's FIRST-EVER live
//                   position (agent_sniper_positions, real on-chain buy), with
//                   no earlier acted copy trade either. Paper fills never count.
//   real loss       the position closed at a realized loss of at least
//                   minLossSol, on at least minEntrySol deployed, so a dust
//                   trade cannot farm the pool.
//   verified rug    the coin carries a rugged verdict from the Coin Intelligence
//                   labeler (pump_coin_outcomes, or its durable copy
//                   oracle_training_set). A coin that merely went down is a bad
//                   trade, not a rug.
//   not the rugger  the coin's creator is known (pump_coin_intel) and is none
//                   of the claimant's wallets, the coin was not launched through
//                   the claimant's own account, none of the claimant's wallets
//                   net-sold the coin (a wallet that profited from the rug), and
//                   the position wallet was not funded by the creator.
//   one person      the position wallet is used by exactly one account (the
//                   self-copy rule from copy-eligibility.js, applied to claims),
//                   the account is older than minAccountAgeHours, is not a
//                   platform account, and the ledger's unique indexes allow one
//                   claim per account and one per receiving wallet, ever.
//   fresh           claims open for claimWindowDays after the close, and the
//                   evidence above has to exist at claim time. It is snapshotted
//                   into the ledger row, so the payout later never depends on
//                   data the retention window has since pruned.
//
// The payout is reimbursePct of the realized SOL loss, valued in USD at claim
// time and capped at maxPerClaimUsd; it is converted to $THREE at the live
// price when it is paid (payouts.js), under a rolling daily cap.

import { sql as defaultSql } from '../db.js';
import { isAdminUser } from '../admin.js';

const LAMPORTS = 1e9;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const round2 = (x) => Math.round(x * 100) / 100;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const lamToSol = (v) => (v == null ? null : Number(v) / LAMPORTS);

export const SIMULATED_SIG = 'SIMULATED';

/** Every criterion, in the order the UI and the ops report list them. */
export const RUG_CRITERIA = Object.freeze([
	'has_live_position',
	'first_position_closed',
	'first_trade',
	'realized_loss',
	'min_entry',
	'verified_rug',
	'claim_window',
	'account_age',
	'not_platform_account',
	'creator_verified',
	'not_creator',
	'not_insider',
	'wallet_unshared',
	'not_claimed',
	'price_available',
]);

/**
 * Decide a first-rug claim from gathered evidence. PURE: evidence in, verdict
 * out, no clock unless one is passed.
 *
 * @param {object} ev  see gatherRugEvidence for the shape
 * @param {ReturnType<typeof import('./config.js').programConfig>['rugSoftener']} cfg
 * @param {number} [now]
 */
export function evaluateRugClaim(ev, cfg, now = Date.now()) {
	const unmet = [];
	const miss = (criterion, label) => unmet.push({ criterion, label });
	const p = ev?.position || null;

	if (!p) {
		miss('has_live_position', 'no live (non-paper) trade on record yet');
		return { eligible: false, unmet, amount: null };
	}
	if (p.status !== 'closed' || !p.closed_at) miss('first_position_closed', 'your first trade is still open');
	if (ev.earlierCopyAt) miss('first_trade', 'an earlier copy trade came before this position, so it is not your first trade');

	const entrySol = lamToSol(p.entry_quote_lamports) ?? 0;
	const pnlSol = lamToSol(p.realized_pnl_lamports);
	const lossSol = pnlSol != null && pnlSol < 0 ? -pnlSol : 0;
	if (!(lossSol >= cfg.minLossSol)) miss('realized_loss', `needs a realized loss of at least ${cfg.minLossSol} SOL (had ${round6(lossSol)})`);
	if (!(entrySol >= cfg.minEntrySol)) miss('min_entry', `needs at least ${cfg.minEntrySol} SOL deployed (had ${round6(entrySol)})`);

	if (ev.rug?.rugged !== true) {
		miss('verified_rug', ev.rug ? `the coin's verified outcome is "${ev.rug.outcome}", not a rug` : 'the coin has no verified outcome yet');
	}

	if (p.closed_at) {
		const ageMs = now - new Date(p.closed_at).getTime();
		if (!(ageMs <= cfg.claimWindowDays * DAY_MS)) miss('claim_window', `claims close ${cfg.claimWindowDays} days after the trade closed`);
	}

	const accountAgeH = ev.user?.created_at ? (now - new Date(ev.user.created_at).getTime()) / HOUR_MS : 0;
	if (!(accountAgeH >= cfg.minAccountAgeHours)) miss('account_age', `the account must be at least ${cfg.minAccountAgeHours}h old`);
	if (ev.user?.is_admin || ev.user?.service_account) {
		miss('not_platform_account', 'platform and service accounts are not eligible');
	}

	const wallets = new Set(ev.userWallets || []);
	if (!ev.creator) miss('creator_verified', "the coin's creator could not be verified");
	if ((ev.creator && wallets.has(ev.creator)) || ev.selfLaunched) miss('not_creator', 'this coin was created by one of your wallets or launched from your account');

	if ((ev.netSellerWallets || []).length > 0) miss('not_insider', 'one of your wallets sold this coin at a profit');
	else if (ev.creator && ev.positionFunder && ev.positionFunder === ev.creator) {
		miss('not_insider', "the trading wallet was funded by the coin's creator");
	}

	if ((ev.walletUsers || 1) > 1) miss('wallet_unshared', 'the trading wallet is used by more than one account');
	if (ev.existingClaim) miss('not_claimed', 'a softener claim already exists for this account or wallet');
	if (!(ev.solUsd > 0)) miss('price_available', 'the SOL price is unavailable right now, so the amount cannot be quoted');

	const amount = computeSoftenerAmount({ lossSol, solUsd: ev.solUsd, cfg });
	return { eligible: unmet.length === 0, unmet, amount };
}

/**
 * The softener amount. PURE.
 * reimbursePct of the realized loss, in USD at solUsd, capped per claim.
 */
export function computeSoftenerAmount({ lossSol, solUsd, cfg }) {
	const reimburseSol = Math.max(0, Number(lossSol) || 0) * (cfg.reimbursePct / 100);
	const rawUsd = solUsd > 0 ? reimburseSol * solUsd : 0;
	const usd = Math.min(rawUsd, cfg.maxPerClaimUsd);
	return {
		loss_sol: round6(Number(lossSol) || 0),
		reimburse_pct: cfg.reimbursePct,
		reimburse_sol: round6(reimburseSol),
		sol_usd: solUsd > 0 ? round2(solUsd) : null,
		usd: round2(usd),
		capped: rawUsd > cfg.maxPerClaimUsd,
	};
}

/**
 * Gather every fact evaluateRugClaim needs for one account, from real tables.
 * Each read degrades to "unknown" (which fails the matching criterion) rather
 * than to a permissive default.
 */
export async function gatherRugEvidence(userId, { sql = defaultSql, solUsd = null } = {}) {
	const [user] = await sql`
		select id, created_at, is_admin, service_account, deleted_at, wallet_address from users where id = ${userId}
	`;
	if (!user || user.deleted_at) return { user: null, position: null };
	// Admin by wallet list counts as a platform account too, not only is_admin.
	const admin = user.is_admin || (await isAdminUser(user).catch(() => false));

	const [position] = await sql`
		select p.id, p.agent_id, p.wallet, p.mint, p.symbol, p.status, p.exit_reason,
		       p.entry_quote_lamports, p.realized_pnl_lamports, p.realized_pnl_pct,
		       p.opened_at, p.closed_at, p.buy_sig, p.sell_sig
		from agent_sniper_positions p
		where p.user_id = ${userId} and p.network = 'mainnet'
		  and p.status in ('open', 'closed')
		  and p.buy_sig is not null and p.buy_sig <> ${SIMULATED_SIG}
		order by p.opened_at asc
		limit 1
	`;
	const base = { user: { ...user, is_admin: admin }, position: position || null, solUsd };
	if (!position) return base;

	const [earlierCopy, rugRows, creatorRow, walletRows, walletUserRows, launched, claimRows] = await Promise.all([
		sql`
			select min(created_at) as at from copy_executions
			where copier_user_id = ${userId} and status = 'acted' and direction = 'buy'
			  and created_at < ${position.opened_at}
		`.catch(() => [{ at: null }]),
		sql`
			select rugged, outcome, 'pump_coin_outcomes' as source from pump_coin_outcomes where mint = ${position.mint}
			union all
			select rugged, outcome, 'oracle_training_set' as source from oracle_training_set
			where mint = ${position.mint} and network = 'mainnet'
		`.catch(() => []),
		sql`select creator from pump_coin_intel where mint = ${position.mint} and network = 'mainnet' limit 1`.catch(() => []),
		sql`
			select address from user_wallets where user_id = ${userId}
			union
			select meta->>'solana_address' from agent_identities where user_id = ${userId} and meta->>'solana_address' is not null
			union
			select wallet from agent_sniper_positions where user_id = ${userId} and wallet is not null
		`.catch(() => []),
		sql`select count(distinct user_id)::int as n from agent_sniper_positions where wallet = ${position.wallet}`.catch(() => [{ n: 1 }]),
		sql`select 1 from pump_agent_mints where user_id = ${userId} and mint = ${position.mint} limit 1`.catch(() => []),
		sql`
			select id from growth_program_payouts
			where program = 'rug_softener' and (user_id = ${userId} or recipient_wallet = ${position.wallet})
			limit 1
		`.catch(() => []),
	]);

	const userWallets = walletRows.map((r) => r.address).filter(Boolean);
	const trading = await sql`
		select wallet, buy_lamports, sell_lamports, funder from pump_coin_wallets
		where mint = ${position.mint} and wallet = any(${userWallets}::text[])
	`.catch(() => []);
	const netSellerWallets = trading
		.filter((t) => Number(t.sell_lamports || 0) > Number(t.buy_lamports || 0))
		.map((t) => t.wallet);
	const positionFunder = trading.find((t) => t.wallet === position.wallet)?.funder || null;

	// Prefer the live labeler's verdict; fall back to the durable copy.
	const rug = rugRows.find((r) => r.source === 'pump_coin_outcomes' && r.rugged != null) || rugRows.find((r) => r.rugged != null) || null;

	return {
		...base,
		earlierCopyAt: earlierCopy?.[0]?.at || null,
		rug: rug ? { rugged: rug.rugged === true, outcome: rug.outcome, source: rug.source } : null,
		creator: creatorRow?.[0]?.creator || null,
		selfLaunched: launched.length > 0,
		userWallets,
		netSellerWallets,
		positionFunder,
		walletUsers: Number(walletUserRows?.[0]?.n) || 1,
		existingClaim: claimRows.length > 0,
	};
}

/** Shape evidence for a response or a ledger basis, without any other account's data. */
export function evidenceSummary(ev) {
	const p = ev.position;
	return {
		position_id: p?.id || null,
		agent_id: p?.agent_id || null,
		wallet: p?.wallet || null,
		mint: p?.mint || null,
		symbol: p?.symbol || null,
		opened_at: p?.opened_at || null,
		closed_at: p?.closed_at || null,
		entry_sol: p ? round6(lamToSol(p.entry_quote_lamports) ?? 0) : null,
		realized_pnl_sol: p ? round6(lamToSol(p.realized_pnl_lamports) ?? 0) : null,
		buy_sig: p?.buy_sig || null,
		sell_sig: p?.sell_sig || null,
		rug: ev.rug || null,
		creator: ev.creator || null,
	};
}

/**
 * Evaluate one account end to end.
 * @param {string} userId
 * @param {object} cfg  programConfig().rugSoftener
 * @param {{ sql?: Function, solUsd?: number|null, now?: number }} [opts]
 */
export async function rugSoftenerStatus(userId, cfg, { sql = defaultSql, solUsd = null, now = Date.now() } = {}) {
	const ev = await gatherRugEvidence(userId, { sql, solUsd });
	const verdict = evaluateRugClaim(ev, cfg, now);
	return { ev, verdict, evidence: evidenceSummary(ev) };
}

/**
 * Every account with a live position, evaluated: the ops dry run. Bounded to
 * the most recent first trades, which is where any claim could come from.
 */
export async function rugSoftenerCandidates(cfg, { sql = defaultSql, solUsd = null, limit = 200, now = Date.now() } = {}) {
	const users = await sql`
		select user_id, min(opened_at) as first_opened_at
		from agent_sniper_positions
		where network = 'mainnet' and status in ('open', 'closed')
		  and buy_sig is not null and buy_sig <> ${SIMULATED_SIG} and user_id is not null
		group by user_id
		order by first_opened_at desc
		limit ${limit}
	`;
	const out = [];
	for (const u of users) {
		const { verdict, evidence } = await rugSoftenerStatus(u.user_id, cfg, { sql, solUsd, now });
		out.push({ user_id: u.user_id, eligible: verdict.eligible, amount: verdict.amount, unmet: verdict.unmet, evidence });
	}
	return out;
}

/**
 * Record a claim for an eligible account. Only callable when the program is
 * armed; the caller checks the flag. The row lands 'claimed' and the payout
 * cron pays it within the daily cap.
 *
 * @returns {Promise<{ ok: true, claim: object } | { ok: false, code: string, verdict?: object }>}
 */
export async function submitRugClaim(userId, cfg, { sql = defaultSql, solUsd, now = Date.now() } = {}) {
	const { ev, verdict, evidence } = await rugSoftenerStatus(userId, cfg, { sql, solUsd, now });
	if (!verdict.eligible) return { ok: false, code: 'not_eligible', verdict };
	const p = ev.position;
	const basis = { ...evidence, amount: verdict.amount, criteria: RUG_CRITERIA, evaluated_at: new Date(now).toISOString() };
	try {
		const [row] = await sql`
			insert into growth_program_payouts
				(program, subject_key, user_id, agent_id, position_id, recipient_wallet, usd_value, basis, status)
			values
				('rug_softener', ${'position:' + p.id}, ${userId}, ${p.agent_id}, ${p.id}, ${p.wallet},
				 ${verdict.amount.usd}, ${JSON.stringify(basis)}::jsonb, 'claimed')
			returning id, status, usd_value::float as usd_value, recipient_wallet, created_at
		`;
		return { ok: true, claim: row };
	} catch (err) {
		// The unique indexes are the last line: a concurrent double-submit, or a
		// second account pointing at the same wallet, lands here.
		if (/duplicate key|unique/i.test(String(err?.message))) return { ok: false, code: 'already_claimed' };
		throw err;
	}
}
