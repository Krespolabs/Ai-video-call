// Copy Coach: takes a cautious first-timer from zero to one safe, small,
// capped copy (roadmap 917, prompt 14.3). Backs /copy-coach and
// /api/copy/coach.
//
// The path, in order, and why each step is safe:
//   1. See one real win AND the full record of the agent that made it. A win
//      is shown only with its on-chain buy and sell signatures, and always next
//      to that agent's losing trades, so a cherry-picked screenshot cannot pass
//      for a track record.
//   2. Ghost-copy a leader with fake money over its real closed trades
//      (api/_lib/ghost-copy.js). No wallet, no signature.
//   3. One real copy under STARTER_CAPS (api/_lib/copy-engine.js), which the
//      server enforces, after an explicit confirmation card. Even then nothing
//      is spent at subscribe time: every copied entry arrives as an intent the
//      user signs from their own wallet.
//   4. Only then, full copy with caps they choose.
//
// The conversational layer answers questions through the platform LLM chain,
// grounded in a fact sheet built here from real rows. No reply is trusted as
// written: validateCoachReply() refuses one that promises returns, adds a
// number the facts do not hold, names another coin, or links off-platform, and
// the deterministic guide answers instead. The completion function is
// injectable so tests drive the real prompt, parsing and validation.

import { sql } from './db.js';
import { llmComplete } from './llm.js';
import { fetchGhostableLeaders, runGhostCopy } from './ghost-copy.js';
import { evaluateLeaderEligibility, leaderCopyProfile, LEADER_ELIGIBILITY } from './copy-eligibility.js';
import { STARTER_CAPS } from './copy-engine.js';
import { solscanTx, SIMULATED_SIG } from './trade-card.js';

export const COACH_STEPS = Object.freeze(['see_a_win', 'ghost_copy', 'starter_copy', 'full_copy']);
export const MAX_REPLY_CHARS = 520;
const MAX_HISTORY = 8;
const MAX_MESSAGE_CHARS = 500;
const WIN_MIN_PNL_PCT = 25;
const WIN_LOOKBACK_DAYS = 14;
const RECORD_DAYS = 30;
const LEADER_POOL = 12;
const LEADERS_SHOWN = 6;
const COACH_TIMEOUT_MS = 18_000;

const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
const lamToSol = (v) => (v == null ? null : Number(v) / 1e9);

// ── data: the real win, the leaders, the ghost facts ────────────────────────

/**
 * The most recent real (signed, not paper) closed win of at least
 * WIN_MIN_PNL_PCT, with the 30-day record of the agent that made it.
 * Returns null when no public agent has one in the lookback.
 */
export async function loadVerifiedWin(network = 'mainnet') {
	const [row] = await sql`
		select p.id, p.agent_id, p.mint, p.symbol, p.name, p.realized_pnl_lamports, p.realized_pnl_pct,
		       p.entry_quote_lamports, p.exit_quote_lamports, p.buy_sig, p.sell_sig, p.opened_at, p.closed_at,
		       a.name as agent_name
		from agent_sniper_positions p
		join agent_identities a on a.id = p.agent_id and a.deleted_at is null and a.is_public is not false
		where p.network = ${network} and p.status = 'closed'
		  and p.buy_sig is not null and p.buy_sig <> ${SIMULATED_SIG}
		  and p.sell_sig is not null and p.sell_sig <> ${SIMULATED_SIG}
		  and p.realized_pnl_pct >= ${WIN_MIN_PNL_PCT}
		  and p.closed_at > now() - make_interval(days => ${WIN_LOOKBACK_DAYS})
		order by p.closed_at desc
		limit 1
	`;
	if (!row) return null;
	const [rec] = await sql`
		select count(*)::int as closed,
		       count(*) filter (where realized_pnl_lamports > 0)::int as wins,
		       coalesce(sum(realized_pnl_lamports), 0)::text as pnl_lamports
		from agent_sniper_positions
		where agent_id = ${row.agent_id} and network = ${network} and status = 'closed'
		  and closed_at > now() - make_interval(days => ${RECORD_DAYS})
	`;
	return shapeWin(row, rec, network);
}

/** Shape the win and its agent's record. Pure. */
export function shapeWin(row, rec, network = 'mainnet') {
	const opened = Date.parse(row.opened_at);
	const closed = Date.parse(row.closed_at);
	const closedCount = Number(rec?.closed) || 0;
	const wins = Number(rec?.wins) || 0;
	return {
		trade_id: row.id,
		agent_id: row.agent_id,
		agent_name: row.agent_name || 'An agent',
		mint: row.mint,
		symbol: row.symbol || null,
		name: row.name || null,
		pnl_pct: round(row.realized_pnl_pct, 1),
		pnl_sol: round(lamToSol(row.realized_pnl_lamports), 4),
		entry_sol: round(lamToSol(row.entry_quote_lamports), 4),
		exit_sol: round(lamToSol(row.exit_quote_lamports), 4),
		hold_seconds: Number.isFinite(opened) && Number.isFinite(closed) ? Math.round((closed - opened) / 1000) : null,
		closed_at: new Date(row.closed_at).toISOString(),
		buy_url: solscanTx(row.buy_sig, network),
		sell_url: solscanTx(row.sell_sig, network),
		trader_url: `/trader/${row.agent_id}`,
		trade_url: `/trade/${row.id}`,
		record: {
			days: RECORD_DAYS,
			closed: closedCount,
			wins,
			losses: closedCount - wins,
			win_rate_pct: closedCount ? round((wins / closedCount) * 100, 1) : null,
			net_pnl_sol: round(lamToSol(rec?.pnl_lamports), 4),
		},
	};
}

/**
 * Leaders a first-timer could ghost-copy, each marked copyable or not against
 * the platform's real eligibility bar, copyable ones first.
 */
export async function loadCoachLeaders(network = 'mainnet', { window = '30d' } = {}) {
	const pool = await fetchGhostableLeaders(network, { window, limit: LEADER_POOL });
	const withBar = await Promise.all(pool.map(async (l) => {
		const profile = await leaderCopyProfile(l.agent_id, network);
		const e = evaluateLeaderEligibility(profile);
		return { ...l, copyable: e.eligible, unmet: e.unmet.map((u) => u.label), max_drawdown_pct: profile?.max_drawdown_pct ?? null };
	}));
	return rankCoachLeaders(withBar).slice(0, LEADERS_SHOWN);
}

/** Copyable first, then by realized PnL. Pure. */
export function rankCoachLeaders(leaders) {
	return leaders.slice().sort((a, b) => (Number(b.copyable) - Number(a.copyable)) || ((b.pnl_sol ?? -Infinity) - (a.pnl_sol ?? -Infinity)));
}

/**
 * The ghost-copy facts for one leader, recomputed server side from the same
 * public replay the page shows, so the coach never talks about numbers the
 * user typed in. Returns null when the leader is unknown.
 */
export async function loadGhostFacts({ leaderId, network = 'mainnet', window = '30d', budgetSol = 1 }) {
	const run = await runGhostCopy({ agentId: leaderId, network, window, budgetSol });
	if (!run || run.error) return null;
	const s = run.summary || {};
	return {
		leader_id: leaderId,
		leader_name: run.leader?.name || null,
		window: run.window,
		budget_sol: run.budget_sol,
		end_sol: round(s.end_sol, 4),
		realized_pnl_sol: round(s.realized_pnl_sol, 4),
		realized_pnl_pct: round(s.realized_pnl_pct, 1),
		copied: s.copied ?? null,
		wins: s.wins ?? null,
		losses: s.losses ?? null,
		win_rate_pct: round(s.win_rate_pct, 1),
		max_drawdown_pct: round(s.max_drawdown_pct, 1),
		skipped: Array.isArray(run.skipped) ? run.skipped.length : null,
	};
}

// ── the fact sheet and the guide ────────────────────────────────────────────

/**
 * Plain-text facts the coach may cite. Every number in a reply has to appear
 * here. Pure.
 */
export function buildCoachFacts({ step, win = null, leader = null, ghost = null, caps = STARTER_CAPS }) {
	const lines = [`current_step: ${step}`];
	lines.push(`starter_caps: at most ${caps.per_trade_cap_sol} SOL per copied trade, at most ${caps.daily_budget_sol} SOL per day, at most ${caps.max_open_copies} open copies, and the copy pauses itself if the leader draws down more than ${caps.max_drawdown_pct}%`);
	lines.push('custody: non-custodial. Every copied entry arrives as an intent the user signs from their own wallet; three.ws never holds their keys and never trades for them in this flow.');
	lines.push('ghost_copy: fake money replayed over a leader\'s real closed trades. No wallet, no signature, nothing at risk.');
	lines.push('fees: a performance fee applies only to profit on copied trades, never to losses.');
	if (win) {
		lines.push(`verified_win: ${win.agent_name} made ${win.pnl_pct}% (${win.pnl_sol} SOL) on ${win.symbol ? `$${win.symbol}` : 'one coin'}, with signed buy and sell transactions on Solana.`);
		const r = win.record;
		lines.push(`that_agents_${r.days}_day_record: ${r.closed} closed trades, ${r.wins} wins, ${r.losses} losses, win rate ${r.win_rate_pct}%, net ${r.net_pnl_sol} SOL.`);
	}
	if (leader) {
		lines.push(`chosen_leader: ${leader.name}, ${leader.settled} closed trades, win rate ${leader.win_rate_pct}%, net ${leader.pnl_sol} SOL, copyable ${leader.copyable ? 'yes' : `no (${(leader.unmet || []).join('; ')})`}.`);
	}
	if (ghost) {
		lines.push(`ghost_result: ${ghost.budget_sol} fake SOL over ${ghost.window} became ${ghost.end_sol} SOL (${ghost.realized_pnl_pct}% realized), ${ghost.copied} trades copied, ${ghost.wins} won, ${ghost.losses} lost, worst drawdown ${ghost.max_drawdown_pct}%.`);
	}
	return lines.join('\n');
}

/** Rough intent of a question, for the deterministic guide. Pure. */
export function questionIntent(message) {
	const m = String(message || '').toLowerCase();
	if (/guarant|promise|sure|certain|can'?t lose|risk.?free|safe bet/.test(m)) return 'guarantee';
	if (/lose|loss|risk|scam|rug|dangerous/.test(m)) return 'risk';
	if (/key|custod|wallet|sign|withdraw|steal|access/.test(m)) return 'custody';
	if (/fee|cost|charge|pay/.test(m)) return 'fees';
	if (/ghost|paper|fake|practice|simulat/.test(m)) return 'ghost';
	if (/cap|limit|max|how much|budget/.test(m)) return 'caps';
	if (/stop|pause|cancel|quit|undo/.test(m)) return 'stop';
	return 'next';
}

const NEXT_BY_STEP = {
	see_a_win: 'Look at the win and then at the same agent\'s full record under it: one good trade is not a track record. When you are ready, the next step replays a leader with fake money.',
	ghost_copy: 'Pick a leader and run the ghost copy: it replays their real closed trades with fake money, so you see the ups and the drawdowns before anything real is involved.',
	starter_copy: 'If the ghost run still makes sense to you, the starter copy is the smallest real step: tiny fixed sizes, a daily cap, and you sign every trade yourself.',
	full_copy: 'Stay at starter size until you have watched a few real copies land. Raise the caps only when the record, not a single win, earns it.',
};

/**
 * The deterministic answer, used when the LLM chain is down or its reply
 * fails validation. Built only from the caps and facts. Pure.
 */
export function guideAnswer(message, { step = 'see_a_win', caps = STARTER_CAPS } = {}) {
	switch (questionIntent(message)) {
		case 'guarantee':
			return 'There are no guarantees here, and anyone who offers one is selling something. The honest signal is a verified track record with real money behind it, which is why every number on this page links to its on-chain transaction.';
		case 'risk':
			return `Yes, you can lose what you put in. That is why the first real copy is capped at ${caps.per_trade_cap_sol} SOL per trade and ${caps.daily_budget_sol} SOL per day, and pauses itself if the leader draws down more than ${caps.max_drawdown_pct}%.`;
		case 'custody':
			return 'Your keys stay with you. A copy here is a notice that the leader traded; nothing moves until you sign the trade from your own wallet, and you can pause or stop the copy at any time.';
		case 'fees':
			return 'Ghost copying is free. A real copy carries a performance fee on profit only, never on losses, and the confirmation card shows it before you agree to anything.';
		case 'ghost':
			return 'A ghost copy replays a leader\'s real closed trades with fake money. It costs nothing and needs no wallet, so it is the right place to learn how a leader behaves in a bad week.';
		case 'caps':
			return `The starter copy is hard-capped by the server, not just the sliders: at most ${caps.per_trade_cap_sol} SOL per trade, ${caps.daily_budget_sol} SOL per day and ${caps.max_open_copies} open copies at once.`;
		case 'stop':
			return 'You can pause or stop a copy from your copy dashboard at any time, and since you sign every trade yourself, simply not signing also stops it.';
		default:
			return NEXT_BY_STEP[step] || NEXT_BY_STEP.see_a_win;
	}
}

// ── the conversational layer ────────────────────────────────────────────────

export const COACH_SYSTEM = `You are the three.ws Copy Coach: a friendly guide for a brand-new user who has never copy-traded. Goal: get them to a confident first action with the SMALLEST safe step. You never push, never promise returns, and always disclose risk plainly ("you can lose what you put in").

The path you steer toward, in order:
1. See one verified win AND the same agent's full record (one win is not a track record).
2. Ghost-copy a leader with fake money over their real trades.
3. One real starter copy at tiny, server-enforced caps, from their own wallet, signed by them.
4. Only then, a full copy with caps they choose.

Rules:
- Answer in 1 to 3 short sentences.
- Use ONLY the FACTS given. Every number you write must appear in the FACTS exactly. If a fact is missing, say you do not have it.
- Explain WHY a step is safe (non-custodial, hard caps, they sign) when it helps.
- If they ask for guarantees, say plainly there are none and point to the verified track record and skin in the game as the honest signal.
- If a leader lost money in the facts, say so plainly and do not talk them into copying it.
- Never name any coin or token except one in the FACTS or $THREE. No links to other sites. No emojis.`;

const PROMISE_RE = /\b(guaranteed?\s+(?:profit|return|win|gain|income|money)s?|you(?:'ll| will)\s+(?:make|earn|profit|double|win)|can'?t\s+lose|cannot\s+lose|won'?t\s+lose|risk[- ]free\s+(?:profit|return|income|money)|sure\s+thing|free\s+money|easy\s+money|to\s+the\s+moon|get\s+rich|passive\s+income)\b/i;
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|io|xyz|net|org|app|gg)\b)/i;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,15})\b/g;
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;

function numbersIn(text) {
	return (String(text).match(NUMBER_RE) || []).map((n) => n.replace(',', '.'));
}

/**
 * Check a coach reply against the facts it was given. Pure.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateCoachReply(reply, facts) {
	const text = String(reply || '').trim();
	if (text.length < 8) return { ok: false, reason: 'too_short' };
	if (text.length > MAX_REPLY_CHARS) return { ok: false, reason: 'too_long' };
	if (PROMISE_RE.test(text)) return { ok: false, reason: 'promise' };
	if (URL_RE.test(text.replace(/\b(?:pump\.fun|three\.ws)\b/gi, ''))) return { ok: false, reason: 'link' };
	const allowedTickers = new Set(['three', ...[...String(facts).matchAll(TICKER_RE)].map((m) => m[1].toLowerCase())]);
	for (const m of text.matchAll(TICKER_RE)) {
		if (!allowedTickers.has(m[1].toLowerCase())) return { ok: false, reason: 'foreign_ticker' };
	}
	// Step numbers ("step 2") are structure, not facts.
	const grounded = new Set([...numbersIn(facts), '1', '2', '3', '4']);
	for (const n of numbersIn(text)) {
		if (!grounded.has(n)) return { ok: false, reason: `ungrounded_number:${n}` };
	}
	return { ok: true };
}

/** Trim and bound a client-supplied history. Pure. */
export function sanitizeHistory(history) {
	if (!Array.isArray(history)) return [];
	return history
		.filter((h) => h && (h.role === 'user' || h.role === 'coach') && typeof h.text === 'string')
		.slice(-MAX_HISTORY)
		.map((h) => ({ role: h.role, text: h.text.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS) }))
		.filter((h) => h.text);
}

/** The user turn for the chain: facts, recent history, the question. Pure. */
export function buildCoachPrompt({ facts, history = [], message }) {
	const convo = history.map((h) => `${h.role === 'user' ? 'User' : 'Coach'}: ${h.text}`).join('\n');
	return `FACTS:\n${facts}\n\n${convo ? `CONVERSATION SO FAR:\n${convo}\n\n` : ''}User: ${String(message).slice(0, MAX_MESSAGE_CHARS)}\nCoach:`;
}

const MAX_SENTENCES = 3;

/**
 * Normalize a model reply and hold it to the three sentences the coach is
 * asked for. Trimming can only remove a claim, never add one. Pure.
 */
export function cleanReply(text) {
	const flat = String(text || '')
		.replace(/^\s*(?:coach|assistant)\s*:\s*/i, '')
		.replace(/^["'\s]+|["'\s]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z0-9$"'(])/);
	return sentences.slice(0, MAX_SENTENCES).join(' ');
}

/**
 * Answer one coach question. Always returns an answer: the chain's when it is
 * reachable and passes validation, the guide's otherwise.
 *
 * @returns {Promise<{ reply: string, source: 'llm'|'guide', model?: string, rejected?: string }>}
 */
export async function coachReply({ message, history = [], step = 'see_a_win', facts, complete = llmComplete, timeoutMs = COACH_TIMEOUT_MS }) {
	const safeStep = COACH_STEPS.includes(step) ? step : 'see_a_win';
	const fallback = (rejected) => ({ reply: guideAnswer(message, { step: safeStep }), source: 'guide', ...(rejected ? { rejected } : {}) });
	let res;
	try {
		res = await complete({
			system: COACH_SYSTEM,
			user: buildCoachPrompt({ facts, history: sanitizeHistory(history), message }),
			maxTokens: 220,
			timeoutMs,
			track: { tool: 'copy_coach' },
		});
	} catch {
		return fallback('chain_unavailable');
	}
	const reply = cleanReply(res?.text);
	const verdict = validateCoachReply(reply, facts);
	if (!verdict.ok) return fallback(verdict.reason);
	return { reply, source: 'llm', model: res?.model || null };
}

export { LEADER_ELIGIBILITY, STARTER_CAPS };
