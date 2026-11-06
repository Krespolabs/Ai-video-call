// Daily trading quests: small, provable goals that reset every UTC midnight.
// ---------------------------------------------------------------------------
// Habit formation on top of streaks + badges (api/_lib/streaks.js). Every quest
// is computed from an event that already proves itself, never from a claim:
//
//   trades_3     verified user-signed trades (buy-confirm / sell-confirm check the
//                signature on-chain) from a wallet LINKED to the account, plus
//                confirmed Co-Pilot trades on an agent the user owns
//   fork_trade   one of those verified trades opened from a Fork
//   ghost_new    the first ghost-copy of a leader this user never replayed before
//   copy_act     a copy intent the user acted on (copy_executions)
//   agent_green  an agent the user owns closes a LIVE trade in profit (positions ledger)
//
// Clearing any DAILY_CLEAR.need quests in one UTC day is a daily clear. Rewards
// are XP and badges. XP lives in trading_quest_completions as insert-only rows,
// so a total never shrinks when an underlying row later changes. A $THREE reward
// for a daily clear exists in api/_lib/quest-rewards.js and ships DISARMED.
//
// Awards are made when progress is read, for today and yesterday: the proof
// tables are durable, so a day's progress is recomputable after the fact, and
// one day of grace means finishing a quest at 23:59 UTC still counts.

import { sql } from './db.js';
import { unlockBadge, listBadges, BADGES } from './streaks.js';
import { SIMULATED_SIG } from './trade-card.js';
import { isUuid } from './validate.js';

export const QUESTS = Object.freeze([
	{
		code: 'trades_3',
		title: 'Make 3 trades',
		detail: 'Buy or sell any pump.fun coin three times today, signed by a wallet linked to your account, or through the Co-Pilot on an agent you own.',
		target: 3,
		xp: 30,
		cta: { label: 'Open the live trade feed', href: '/trades' },
	},
	{
		code: 'fork_trade',
		title: 'Fork a verified trade',
		detail: 'Tap Fork on a verified trade and sign it from your own wallet at your own size.',
		target: 1,
		xp: 25,
		cta: { label: 'Find a trade to fork', href: '/trades' },
	},
	{
		code: 'ghost_new',
		title: 'Ghost-copy a new agent',
		detail: 'Replay a leader you have never ghost-copied before, with fake money. Nothing is signed.',
		target: 1,
		xp: 15,
		cta: { label: 'Pick a leader', href: '/ghost-copy' },
	},
	{
		code: 'copy_act',
		title: 'Act on a copy intent',
		detail: 'Execute a copy intent from a leader you follow, then mark it copied.',
		target: 1,
		xp: 25,
		cta: { label: 'Open your copy intents', href: '/dashboard/copy' },
	},
	{
		code: 'agent_green',
		title: 'Your agent closes a winner',
		detail: 'An agent you own closes a live trade in profit. Paper trades do not count.',
		target: 1,
		xp: 20,
		cta: { label: 'Tune your trader', href: '/strategy-lab' },
	},
]);

export const DAILY_CLEAR = Object.freeze({ code: 'daily_clear', need: 3, xp: 50 });

const DAY_MS = 86_400_000;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The UTC day (YYYY-MM-DD) a timestamp falls on. PURE. */
export function utcDay(at = Date.now()) {
	return new Date(typeof at === 'number' ? at : new Date(at).getTime()).toISOString().slice(0, 10);
}

/** [start, end) of a UTC day as ISO strings. PURE. */
export function dayBounds(day) {
	const start = Date.parse(`${day}T00:00:00.000Z`);
	return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

/** The day before a UTC day. PURE. */
export function previousDay(day) {
	return utcDay(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS);
}

/**
 * XP needed to REACH a level: 0, 100, 300, 600, 1000, ... (50 * L * (L - 1)).
 * Each level asks for 100 XP more than the last, so early levels come fast and
 * later ones mean something. PURE.
 */
export function xpForLevel(level) {
	const l = Math.max(1, Math.floor(level));
	return 50 * l * (l - 1);
}

/** Level progress for an XP total. PURE. */
export function levelFor(totalXp) {
	const xp = Math.max(0, Math.floor(n(totalXp)));
	let level = 1;
	while (xpForLevel(level + 1) <= xp) level++;
	const floor = xpForLevel(level);
	const next = xpForLevel(level + 1);
	return { total: xp, level, into_level: xp - floor, level_span: next - floor, next_level_at: next };
}

/**
 * Fold a day's raw counts into quest progress. PURE.
 * @param {object} counts  { trades, forks, ghosts, acted, green }
 * @param {Set<string>|string[]} [awarded]  quest codes already awarded that day.
 */
export function evaluateQuests(counts = {}, awarded = []) {
	const done = new Set(awarded);
	const raw = {
		trades_3: n(counts.trades),
		fork_trade: n(counts.forks),
		ghost_new: n(counts.ghosts),
		copy_act: n(counts.acted),
		agent_green: n(counts.green),
	};
	const quests = QUESTS.map((q) => {
		const progress = Math.min(q.target, raw[q.code]);
		// An award already made stays made, even if a later read counts fewer rows.
		const complete = progress >= q.target || done.has(q.code);
		return { ...q, progress: complete ? q.target : progress, done: complete };
	});
	const doneCount = quests.filter((q) => q.done).length;
	return {
		quests,
		done_count: doneCount,
		cleared: doneCount >= DAILY_CLEAR.need || done.has(DAILY_CLEAR.code),
	};
}

/**
 * Consecutive UTC days with a daily clear, ending today or yesterday (a streak
 * is still alive until a whole day passes without a clear). PURE.
 * @param {string[]} clearDays  YYYY-MM-DD strings.
 * @param {string} today
 */
export function clearStreak(clearDays = [], today = utcDay()) {
	const set = new Set(clearDays.map((d) => String(d).slice(0, 10)));
	let cursor = set.has(today) ? today : previousDay(today);
	let current = 0;
	while (set.has(cursor)) {
		current++;
		cursor = previousDay(cursor);
	}
	const sorted = [...set].sort();
	let longest = 0;
	let run = 0;
	let prev = null;
	for (const d of sorted) {
		run = prev && previousDay(d) === prev ? run + 1 : 1;
		if (run > longest) longest = run;
		prev = d;
	}
	return { current, longest };
}

// ── Recording (the two events with no other durable trace) ──────────────────

/**
 * Record a user-signed trade whose signature was verified on-chain. First claim
 * of a signature wins. Never throws: a quest record must not fail a trade.
 */
export async function recordQuestTrade({ userId, signature, network = 'mainnet', wallet, origin = null, direction = null, mint = null }) {
	if (!userId || !signature) return false;
	try {
		const rows = await sql`
			insert into trading_quest_events (user_id, kind, ref, network, origin, wallet, context)
			values (${userId}, 'trade', ${signature}, ${network}, ${origin === 'fork' ? 'fork' : null}, ${wallet || null},
			        ${JSON.stringify({ direction, mint })}::jsonb)
			on conflict do nothing
			returning id
		`;
		return rows.length > 0;
	} catch (err) {
		console.warn('[trading-quests] recordQuestTrade skipped:', err?.message);
		return false;
	}
}

/**
 * Record that a signed-in user ghost-copied a leader. Only the first ghost of a
 * given leader is kept, which is exactly what "a new agent" means. The leader
 * must be a public agent with at least one closed round-trip, the same universe
 * the ghost-copy picker offers.
 * @returns {Promise<{ok:boolean, new_agent?:boolean, error?:string}>}
 */
export async function recordGhostQuest({ userId, leaderId, network = 'mainnet', context = null }) {
	if (!userId || !isUuid(leaderId)) return { ok: false, error: 'leader_agent_id must be an agent UUID' };
	const [leader] = await sql`
		select a.id from agent_identities a
		where a.id = ${leaderId} and a.deleted_at is null and a.is_public <> false
		  and exists (
		      select 1 from agent_sniper_positions p
		      where p.agent_id = a.id and p.network = ${network} and p.status = 'closed'
		  )
		limit 1
	`;
	if (!leader) return { ok: false, error: 'That leader has no closed trades to ghost-copy.' };
	const rows = await sql`
		insert into trading_quest_events (user_id, kind, ref, network, context)
		values (${userId}, 'ghost_copy', ${leaderId}, ${network}, ${context ? JSON.stringify(context) : null}::jsonb)
		on conflict do nothing
		returning id
	`;
	return { ok: true, new_agent: rows.length > 0 };
}

// ── Progress + awards ────────────────────────────────────────────────────────

/** Raw counts for one user on one UTC day, one round-trip. */
async function dayCounts(userId, day) {
	const { start, end } = dayBounds(day);
	const [row] = await sql`
		with linked as (
			select address from user_wallets where user_id = ${userId} and chain_type = 'solana'
			union
			select wallet_address from users where id = ${userId} and wallet_address is not null
		),
		trades as (
			select e.ref as sig, e.origin
			from trading_quest_events e
			where e.user_id = ${userId} and e.kind = 'trade'
			  and e.created_at >= ${start} and e.created_at < ${end}
			  and e.wallet in (select address from linked)
			union
			select t.tx_signature as sig, null as origin
			from pump_agent_trades t
			where t.user_id = ${userId} and t.tx_signature is not null
			  and t.created_at >= ${start} and t.created_at < ${end}
			  and t.wallet in (select address from linked)
			union
			select c.signature as sig, null as origin
			from agent_custody_events c
			where c.user_id = ${userId} and c.event_type = 'spend' and c.category = 'trade'
			  and c.status = 'confirmed' and c.signature is not null
			  and c.created_at >= ${start} and c.created_at < ${end}
		)
		select
			(select count(distinct sig) from trades)::int as trades,
			(select count(distinct sig) from trades where origin = 'fork')::int as forks,
			(select count(*) from trading_quest_events g
			  where g.user_id = ${userId} and g.kind = 'ghost_copy'
			    and g.created_at >= ${start} and g.created_at < ${end})::int as ghosts,
			(select count(*) from copy_executions x
			  where x.copier_user_id = ${userId} and x.status = 'acted'
			    and x.updated_at >= ${start} and x.updated_at < ${end})::int as acted,
			(select count(*) from agent_sniper_positions p
			  join agent_identities a on a.id = p.agent_id
			  where a.user_id = ${userId} and p.status = 'closed'
			    and p.closed_at >= ${start} and p.closed_at < ${end}
			    and p.realized_pnl_lamports > 0
			    and p.buy_sig is not null and p.buy_sig <> ${SIMULATED_SIG})::int as green
	`;
	return row || {};
}

async function awardedCodes(userId, day) {
	const rows = await sql`
		select code from trading_quest_completions where user_id = ${userId} and day = ${day}::date
	`;
	return new Set(rows.map((r) => r.code));
}

/** Insert the completions a day newly earned. Returns the codes newly awarded. */
async function awardDay(userId, day, evaluation, alreadyAwarded) {
	const fresh = [];
	for (const q of evaluation.quests) {
		if (!q.done || alreadyAwarded.has(q.code)) continue;
		const rows = await sql`
			insert into trading_quest_completions (user_id, day, code, xp)
			values (${userId}, ${day}::date, ${q.code}, ${q.xp})
			on conflict do nothing
			returning code
		`;
		if (rows.length) fresh.push(q.code);
	}
	if (evaluation.cleared && !alreadyAwarded.has(DAILY_CLEAR.code)) {
		const rows = await sql`
			insert into trading_quest_completions (user_id, day, code, xp)
			values (${userId}, ${day}::date, ${DAILY_CLEAR.code}, ${DAILY_CLEAR.xp})
			on conflict do nothing
			returning code
		`;
		if (rows.length) fresh.push(DAILY_CLEAR.code);
	}
	return fresh;
}

/** Evaluate and award one day. */
async function settleDay(userId, day) {
	const [counts, awarded] = await Promise.all([dayCounts(userId, day), awardedCodes(userId, day)]);
	const evaluation = evaluateQuests(counts, awarded);
	const fresh = await awardDay(userId, day, evaluation, awarded);
	return { day, evaluation, fresh };
}

const QUEST_BADGES = new Set([BADGES.QUEST_FIRST, BADGES.QUEST_CLEAR, BADGES.QUEST_STREAK_7]);

/**
 * A signed-in user's quest board for today. Awards anything newly earned today
 * or yesterday, then reads the XP total, the clear streak, and quest badges.
 */
export async function loadQuestBoard(userId, { now = Date.now() } = {}) {
	const today = utcDay(now);
	const yesterday = previousDay(today);
	const [todayResult, yesterdayResult] = await Promise.all([settleDay(userId, today), settleDay(userId, yesterday)]);

	const [[totals], clearRows] = await Promise.all([
		sql`
			select coalesce(sum(xp), 0)::int as xp,
			       count(*) filter (where code <> ${DAILY_CLEAR.code} and code not like 'duel:%')::int as quests_done
			from trading_quest_completions where user_id = ${userId}
		`,
		sql`
			select day::text as day from trading_quest_completions
			where user_id = ${userId} and code = ${DAILY_CLEAR.code}
			order by day desc limit 400
		`,
	]);
	const streak = clearStreak(clearRows.map((r) => r.day), today);

	if (n(totals?.quests_done) > 0) await unlockBadge(userId, BADGES.QUEST_FIRST);
	if (clearRows.length > 0) await unlockBadge(userId, BADGES.QUEST_CLEAR);
	if (streak.current >= 7 || streak.longest >= 7) await unlockBadge(userId, BADGES.QUEST_STREAK_7, { longest: streak.longest });
	const badges = (await listBadges(userId)).filter((b) => QUEST_BADGES.has(b.code));

	const ev = todayResult.evaluation;
	return {
		day: today,
		resets_at: dayBounds(today).end,
		quests: ev.quests,
		daily_clear: { need: DAILY_CLEAR.need, xp: DAILY_CLEAR.xp, done_count: ev.done_count, cleared: ev.cleared },
		yesterday: {
			day: yesterday,
			done_count: yesterdayResult.evaluation.done_count,
			cleared: yesterdayResult.evaluation.cleared,
		},
		xp: levelFor(totals?.xp),
		clear_streak: streak,
		badges,
		newly_completed: [
			...todayResult.fresh.map((code) => ({ day: today, code })),
			...yesterdayResult.fresh.map((code) => ({ day: yesterday, code })),
		],
	};
}

/** The quest catalog for a signed-out visitor: real quests, no progress. PURE. */
export function questCatalog(now = Date.now()) {
	const today = utcDay(now);
	return {
		day: today,
		resets_at: dayBounds(today).end,
		quests: QUESTS.map((q) => ({ ...q, progress: null, done: false })),
		daily_clear: { need: DAILY_CLEAR.need, xp: DAILY_CLEAR.xp },
	};
}

