// @ts-check
// Big-win auto-poster for @trythreews (roadmap 917, 3.8 and 13.5).
//
// When a live agent trade closes as a meaningful win, post it to X with a link
// to its trade card (/trade/:id, rendered by api/trade-share.js with the OG
// image from api/trade-og.js), so the numbers that unfurl are the on-chain
// numbers. Telegram copy intents already shipped; this is the X leg.
//
// Posting to a public feed with no human in the loop is owner gate 2, so the
// lane ships disarmed: BIG_WIN_X_ENABLED unset means every tick is a dry run
// that reports exactly which trade it would post and the exact text, and
// writes nothing.
//
// What may be posted, and why (every rule is a guard below):
//   - Live fills only. A paper fill is a simulation; calling it a win on a
//     public feed would be a lie. Both legs must carry real signatures.
//   - Big AND sized: at least minPct return, minEntrySol deployed, minPnlSol
//     realized. A +200% on a 0.001 SOL test fill is not news.
//   - Public agents only, never P&L on a coin the owner launched (the
//     self-dealing rule from trader-stats.js).
//   - $THREE is the only coin the account promotes, so the post never names
//     the traded coin: no ticker, no cashtag, no mint. The card carries the
//     detail for anyone who clicks.
//   - The composed text must pass the same content filter as the changelog X
//     lane (data/changelog-x-filter.json: no wallet internals, no money
//     movement internals, no other coins, no gated project names) and the
//     account's voice lint (api/_lib/x-content/quality.js). The agent's name is
//     user-controlled, so a name carrying a cashtag, handle, hashtag, or link
//     disqualifies the post rather than being passed through.
//   - Rate: one post per run, dailyCap per 24h, one per agent per
//     perAgentHours, and never past accountDailyCap across every automated
//     lane on the account (changelog replies and the content queue included).

import { sql as defaultSql } from '../db.js';
import { shapeTradeCard, SIMULATED_SIG } from '../trade-card.js';
import { loadXFilter, classifyXError } from '../changelog-push.js';
import { copyProblems, hasUrl } from '../x-content/quality.js';
import { selfDealMintsByUsers } from '../trader-stats.js';

const STATE_KEY = 'big_win_x';
const LOCK_KEY = 'big_win_x_lock';
const LOCK_TTL_S = 180;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ORIGIN = 'https://three.ws';

const realSig = (s) => typeof s === 'string' && s.trim() !== '' && s.trim() !== SIMULATED_SIG;
const lamToSol = (v) => (v == null ? null : Number(v) / 1e9);

/** SOL for a post: plain text, three decimals, no glyphs. */
export function solText(v) {
	const x = Number(v);
	if (!Number.isFinite(x)) return null;
	return `${x.toFixed(3)} SOL`;
}

/**
 * Why a closed position is not a postable big win, or null when it is. PURE.
 * @param {object} row  position joined to its agent (see candidateRows)
 * @param {object} cfg  programConfig().bigWinX
 * @param {{ selfDealing?: boolean }} [ctx]
 */
export function bigWinRejection(row, cfg, { selfDealing = false } = {}) {
	if (!realSig(row.buy_sig) || !realSig(row.sell_sig)) return 'paper_or_unsigned';
	if (row.network !== 'mainnet') return 'not_mainnet';
	if (row.is_public !== true) return 'agent_private';
	if (row.exit_reason === 'error') return 'closed_on_error';
	if (selfDealing) return 'self_dealing';
	const pct = Number(row.realized_pnl_pct);
	if (!(pct >= cfg.minPct)) return `below_min_pct (${Number.isFinite(pct) ? pct.toFixed(1) : 'n/a'}% < ${cfg.minPct}%)`;
	const entry = lamToSol(row.entry_quote_lamports) ?? 0;
	if (!(entry >= cfg.minEntrySol)) return `below_min_entry (${entry.toFixed(4)} < ${cfg.minEntrySol} SOL)`;
	const pnl = lamToSol(row.realized_pnl_lamports) ?? 0;
	if (!(pnl >= cfg.minPnlSol)) return `below_min_pnl (${pnl.toFixed(4)} < ${cfg.minPnlSol} SOL)`;
	return null;
}

/** The agent name, if it is safe to print on the account; else null. PURE. */
export function safeAgentName(name) {
	const s = String(name || '').trim();
	if (!s || s.length > 40) return null;
	if (/[$@#<>]/.test(s) || hasUrl(s)) return null;
	return s;
}

/**
 * Compose the post. PURE. The coin is never named: the card carries it.
 * @param {ReturnType<typeof shapeTradeCard>} card
 */
export function composeBigWinPost(card) {
	const name = safeAgentName(card.agentName);
	if (!name) return null;
	const mult = card.multipleLabel ? ` (${card.multipleLabel})` : '';
	const held = card.holdLabel ? ` in ${card.holdLabel}` : '';
	const legs = [solText(card.entrySol) && `${solText(card.entrySol)} in`, solText(card.exitSol) && `${solText(card.exitSol)} out`]
		.filter(Boolean)
		.join(', ');
	const moonbag = card.moonbag ? ' A moon-bag is still riding.' : '';
	return [
		`${name} closed a live pump.fun trade at ${card.headline}${mult}${held}: ${legs}.${moonbag} Both legs link to their on-chain transactions on the card.`,
		'',
		`${ORIGIN}/trade/${card.id}`,
	].join('\n');
}

/**
 * Every reason the composed text must not go out. PURE given a filter.
 * @param {string} text
 * @param {{ patterns: Array<{pattern:string, reason:string}> }} filter
 */
export function bigWinContentProblems(text, filter) {
	const problems = copyProblems(text, { minimum: 60, maximum: 280, requireUrl: true });
	for (const rule of filter.patterns || []) {
		if (new RegExp(rule.pattern, 'i').test(text)) problems.push(`filter: ${rule.reason}`);
	}
	return problems;
}

/** Candidate closes in the lookback window, wide enough to show near misses. */
async function candidateRows(cfg, sql) {
	return sql`
		select p.id, p.agent_id, p.user_id, p.network, p.mint, p.symbol, p.name, p.status, p.exit_reason,
		       p.entry_quote_lamports, p.exit_quote_lamports, p.realized_pnl_lamports, p.realized_pnl_pct,
		       p.buy_sig, p.sell_sig, p.moonbag_base_amount, p.moonbag_last_value_lamports,
		       p.opened_at, p.closed_at,
		       a.name as agent_name, a.profile_image_url as agent_image, a.avatar_url as agent_avatar, a.is_public
		from agent_sniper_positions p
		join agent_identities a on a.id = p.agent_id and a.deleted_at is null
		where p.status = 'closed' and p.network = 'mainnet'
		  and p.closed_at >= now() - make_interval(hours => ${cfg.lookbackHours})
		  and p.realized_pnl_pct >= 50
		order by p.realized_pnl_lamports desc nulls last
		limit 100
	`;
}

async function readSetting(key, sql) {
	const [row] = await sql`select value from app_settings where key = ${key}`.catch(() => []);
	return row?.value ?? null;
}

async function writeSetting(key, value, sql) {
	await sql`
		insert into app_settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
		on conflict (key) do update set value = excluded.value, updated_at = now()
	`;
}

/**
 * Posts in the trailing 24h across every automated lane on the account. PURE.
 * @param {{ lane: any, changelog: any, content: any }} states
 */
export function accountPostsLast24h({ lane, changelog, content }, now = Date.now()) {
	const inDay = (t) => Number.isFinite(t) && now - t < DAY_MS;
	const laneRecent = (lane?.recent || []).filter(inDay).length;
	const changelogRecent = (changelog?.recent || []).filter(inDay).length;
	const contentRecent = (content?.published || []).map((p) => Date.parse(p?.publishedAt)).filter(inDay).length;
	return { lane: laneRecent, changelog: changelogRecent, content: contentRecent, total: laneRecent + changelogRecent + contentRecent };
}

/**
 * Select what this tick would post. Pure over its inputs (rows, state, time).
 * @returns {{ pick: object|null, considered: object[], blocked: string|null }}
 */
export function selectBigWin({ rows, cfg, state, budget, filter, selfDealByUser, now = Date.now() }) {
	const posted = new Set(state?.posted || []);
	const perAgent = state?.perAgent || {};
	const considered = [];
	let pick = null;
	for (const row of rows) {
		const own = selfDealByUser?.get(row.user_id);
		const card = shapeTradeCard(row, { origin: ORIGIN });
		const entry = {
			position_id: row.id,
			agent: row.agent_name,
			pnl_pct: card.pnlPct,
			entry_sol: card.entrySol,
			pnl_sol: card.pnlSol,
			closed_at: row.closed_at,
			card_url: card.shareUrl,
			reason: null,
			text: null,
			problems: [],
		};
		entry.reason = bigWinRejection(row, cfg, { selfDealing: Boolean(own && own.has(row.mint)) });
		if (!entry.reason && posted.has(row.id)) entry.reason = 'already_posted';
		if (!entry.reason && perAgent[row.agent_id] && now - perAgent[row.agent_id] < cfg.perAgentHours * HOUR_MS) {
			entry.reason = `agent_posted_within_${cfg.perAgentHours}h`;
		}
		if (!entry.reason) {
			const text = composeBigWinPost(card);
			if (!text) entry.reason = 'agent_name_unsafe';
			else {
				entry.text = text;
				entry.problems = bigWinContentProblems(text, filter);
				if (entry.problems.length) entry.reason = 'content_filter';
			}
		}
		if (!entry.reason && !pick) pick = entry;
		considered.push(entry);
	}
	let blocked = null;
	if (budget.lane >= cfg.dailyCap) blocked = `daily_cap (${budget.lane}/${cfg.dailyCap} in 24h)`;
	else if (budget.total >= cfg.accountDailyCap) blocked = `account_daily_cap (${budget.total}/${cfg.accountDailyCap} across all lanes in 24h)`;
	else if (state?.backoffUntil && state.backoffUntil > now) blocked = `rate_limited until ${new Date(state.backoffUntil).toISOString()}`;
	return { pick, considered, blocked };
}

async function acquireLock(sql) {
	const rows = await sql`
		insert into app_settings (key, value)
		values (${LOCK_KEY}, jsonb_build_object('until', extract(epoch from now()) + ${LOCK_TTL_S}))
		on conflict (key) do update
			set value = excluded.value, updated_at = now()
			where (app_settings.value->>'until')::numeric < extract(epoch from now())
		returning key
	`;
	return rows.length > 0;
}

function xCreds(env) {
	const creds = {
		appKey: env.X_API_KEY,
		appSecret: env.X_API_SECRET,
		accessToken: env.X_ACCESS_TOKEN,
		accessSecret: env.X_ACCESS_SECRET,
	};
	return creds.appKey && creds.appSecret && creds.accessToken && creds.accessSecret ? creds : null;
}

async function defaultPoster(creds) {
	const { TwitterApi } = await import('twitter-api-v2');
	const client = new TwitterApi(creds);
	return async (text) => {
		const { data } = await client.v2.tweet(text);
		return data.id;
	};
}

/**
 * One tick of the lane.
 * @param {object} p
 * @param {object} p.cfg      programConfig().bigWinX
 * @param {Function} [p.sql]
 * @param {Record<string,string|undefined>} [p.env]
 * @param {(creds:object) => Promise<(text:string) => Promise<string>>} [p.makePoster]  injected in tests
 * @param {number} [p.now]
 */
export async function runBigWinLane({ cfg, sql = defaultSql, env = process.env, makePoster = defaultPoster, now = Date.now() }) {
	const [rows, lane, changelog, content] = await Promise.all([
		candidateRows(cfg, sql),
		readSetting(STATE_KEY, sql),
		readSetting('changelog_push_x', sql),
		readSetting('x_content', sql),
	]);
	const state = lane || { posted: [], recent: [], perAgent: {} };
	const budget = accountPostsLast24h({ lane: state, changelog, content }, now);
	const selfDealByUser = await selfDealMintsByUsers([...new Set(rows.map((r) => r.user_id))], 'mainnet');
	const filter = loadXFilter();
	const { pick, considered, blocked } = selectBigWin({ rows, cfg, state, budget, filter, selfDealByUser, now });

	const report = {
		lane: 'big_win_x',
		armed: cfg.enabled,
		thresholds: { min_pct: cfg.minPct, min_entry_sol: cfg.minEntrySol, min_pnl_sol: cfg.minPnlSol, lookback_hours: cfg.lookbackHours },
		budget: { ...budget, daily_cap: cfg.dailyCap, account_daily_cap: cfg.accountDailyCap },
		would_post: pick ? { position_id: pick.position_id, text: pick.text, card_url: pick.card_url } : null,
		blocked,
		considered,
	};

	if (!cfg.enabled) return { ...report, executed: false, reason: `${cfg.flag} is not set, so nothing is posted` };
	if (!pick) return { ...report, executed: false, reason: 'no qualifying win in the window' };
	if (blocked) return { ...report, executed: false, reason: blocked };
	const creds = xCreds(env);
	if (!creds) return { ...report, executed: false, reason: 'X credentials not configured' };
	if (!(await acquireLock(sql))) return { ...report, executed: false, reason: 'another tick holds the lane lock' };

	try {
		const post = await makePoster(creds);
		const next = {
			posted: [...(state.posted || []), pick.position_id].slice(-500),
			recent: (state.recent || []).filter((t) => now - t < DAY_MS),
			perAgent: Object.fromEntries(Object.entries(state.perAgent || {}).filter(([, t]) => now - Number(t) < 30 * DAY_MS)),
			backoffUntil: 0,
			lastError: null,
			lastPostAt: state.lastPostAt || null,
			lastPostId: state.lastPostId || null,
		};
		const agentId = rows.find((r) => r.id === pick.position_id)?.agent_id;
		try {
			const id = await post(pick.text);
			next.recent.push(now);
			if (agentId) next.perAgent[agentId] = now;
			next.lastPostAt = new Date(now).toISOString();
			next.lastPostId = id;
			await writeSetting(STATE_KEY, next, sql);
			return { ...report, executed: true, posted: { position_id: pick.position_id, tweet_id: id } };
		} catch (err) {
			const verdict = classifyXError(err, now);
			if (verdict.kind === 'duplicate') {
				// X already holds this exact text; mark it so it never blocks the lane.
				await writeSetting(STATE_KEY, next, sql);
				return { ...report, executed: false, reason: 'duplicate content, marked posted' };
			}
			const failed = { ...next, posted: state.posted || [], lastError: String(err?.message || err).slice(0, 300) };
			if (verdict.kind === 'rate_limited') failed.backoffUntil = verdict.until;
			await writeSetting(STATE_KEY, failed, sql);
			return { ...report, executed: false, reason: `post failed (${verdict.kind}): ${failed.lastError}` };
		}
	} finally {
		await sql`update app_settings set value = '{"until":0}'::jsonb, updated_at = now() where key = ${LOCK_KEY}`.catch(() => {});
	}
}
