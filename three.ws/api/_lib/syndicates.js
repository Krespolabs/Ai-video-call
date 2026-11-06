// Syndicates: named teams of copiers who follow the same leader(s) together.
// ---------------------------------------------------------------------------
// Tribalism is the strongest retention force in crypto, so a syndicate gives a
// copier a team, a flag, and a rival: a named group with a public page, a
// roster, a group equity curve, and a standing on a board against every other
// syndicate. Leaders can run one as their fan club.
//
// It is a layer over the existing copy loop, never a parallel money path:
//
//   - Joining creates ordinary copy_subscriptions rows through subscribeCopier
//     (api/_lib/copy-subscribe.js), the exact gates /api/copy/subscriptions
//     runs: self-copy refusal, the copyable bar, the member's OWN sizing, per-
//     trade cap, daily budget and drawdown breaker. The fanout cron, the intents
//     on /dashboard/copy and the HWM performance fee work unchanged.
//   - No funds are pooled and nothing is custodied. Every member keeps their own
//     wallet and caps. Leaving stops only the subscriptions the join created; a
//     subscription the member already had before joining is left exactly as it was.
//   - Group performance is read live from the members' real copy_executions
//     inside their membership window, priced the way api/_lib/copy-earnings.js
//     prices a copier's realized profit (committed size x the leader's realized
//     return on the positions the copier acted on). Nothing stores a number.
//
// The coins behind any of this are whatever the leaders traded (runtime data).
// $THREE remains the only coin this platform promotes.

import { sql } from './db.js';
import { subscribeCopier, BASE58_RE, COPY_NETWORKS } from './copy-subscribe.js';
import { normalizeSubscriptionInput } from './copy-engine.js';
import { LEADER_ELIGIBILITY, evaluateLeaderEligibility, leaderCopyProfile } from './copy-eligibility.js';
import { containsHateSlur } from './display-name-safety.js';
import { SIMULATED_SIG } from './trade-card.js';
import { unlockBadge, BADGES } from './streaks.js';
import { isUuid } from './validate.js';

/** The flag palette. A fixed set keeps every board legible in both themes. */
export const SYNDICATE_COLORS = Object.freeze([
	'#7c5cff', '#22d3ee', '#34d399', '#f59e0b', '#fb7185', '#f472b6', '#60a5fa', '#a3e635',
]);
export const MAX_SYNDICATE_LEADERS = 3;
/** Active syndicates one user may found per network: a floor against squatting names. */
export const MAX_FOUNDED_PER_NETWORK = 3;
export const BOARD_SORTS = Object.freeze(['profit', 'members', 'new']);
/** Slugs that name an API route under /api/syndicates/, so no syndicate may take them. */
const RESERVED_SLUGS = new Set(['leaders', 'membership', 'index', 'new']);

const LAMPORTS = 1e9;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const lamToSol = (l) => n(l) / LAMPORTS;
const iso = (v) => (v ? new Date(v).toISOString() : null);
const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, extra });
const isUniqueViolation = (err) => err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** A URL slug from a syndicate name: lowercase ascii, hyphen-joined, 3 to 40 chars. PURE. */
export function slugifyName(name) {
	const s = String(name || '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s) ? s : null;
}

/**
 * Validate founding input. PURE.
 * @returns {{ok:true, value:{name:string, motto:string|null, color:string, network:string, leader_agent_ids:string[], slug:string}} | {ok:false, error:string}}
 */
export function validateSyndicateInput(raw = {}) {
	const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : '';
	if (name.length < 3 || name.length > 40) return { ok: false, error: 'Name must be 3 to 40 characters.' };
	const slug = slugifyName(name);
	if (!slug) return { ok: false, error: 'Name needs at least three letters or numbers.' };
	if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'That name is reserved. Pick another.' };

	const mottoRaw = typeof raw.motto === 'string' ? raw.motto.replace(/\s+/g, ' ').trim() : '';
	if (mottoRaw.length > 140) return { ok: false, error: 'Motto must be 140 characters or fewer.' };
	const motto = mottoRaw || null;

	if (containsHateSlur(name) || (motto && containsHateSlur(motto))) {
		return { ok: false, error: 'That name or motto is not allowed.' };
	}

	const color = typeof raw.color === 'string' ? raw.color.toLowerCase() : SYNDICATE_COLORS[0];
	if (!SYNDICATE_COLORS.includes(color)) return { ok: false, error: 'Pick one of the flag colors.' };

	const network = COPY_NETWORKS.has(raw.network) ? raw.network : 'mainnet';

	const ids = Array.isArray(raw.leader_agent_ids) ? raw.leader_agent_ids.map((x) => String(x || '').trim()) : [];
	const unique = [...new Set(ids)];
	if (unique.length === 0) return { ok: false, error: 'Pick at least one leader to follow.' };
	if (unique.length > MAX_SYNDICATE_LEADERS) return { ok: false, error: `A syndicate follows at most ${MAX_SYNDICATE_LEADERS} leaders.` };
	if (!unique.every(isUuid)) return { ok: false, error: 'Every leader must be an agent id.' };

	return { ok: true, value: { name, motto, color, network, leader_agent_ids: unique, slug } };
}

/**
 * Fold a syndicate's closed copies into its group curve. PURE.
 * @param {Array<{closed_at:*, profit_sol:*}>} rows  acted buy copies whose leader position closed, oldest first.
 * @param {number} [maxPoints]
 * @returns {{points:Array<{t:string, cum_sol:number}>, peak_sol:number, trough_sol:number, final_sol:number}}
 */
export function buildGroupCurve(rows = [], maxPoints = 120) {
	let cum = 0;
	let peak = 0;
	let trough = 0;
	const all = [];
	for (const r of rows) {
		const t = r?.closed_at ? new Date(r.closed_at) : null;
		if (!t || Number.isNaN(t.getTime())) continue;
		cum += n(r.profit_sol);
		if (cum > peak) peak = cum;
		if (cum < trough) trough = cum;
		all.push({ t: t.toISOString(), cum_sol: round6(cum) });
	}
	let points = all;
	if (all.length > maxPoints) {
		// Keep the shape honest when thinning: always keep the first and last point
		// and sample evenly between them, never drop the endpoint the headline shows.
		const step = (all.length - 1) / (maxPoints - 1);
		points = Array.from({ length: maxPoints }, (_, i) => all[Math.round(i * step)]);
	}
	return { points, peak_sol: round6(peak), trough_sol: round6(trough), final_sol: round6(cum) };
}

/** Shape one board row from the aggregate query. PURE. */
export function shapeBoardRow(r) {
	const acted = n(r.acted);
	const closed = n(r.closed_copies);
	const wins = n(r.winning_copies);
	const leaderPnl = lamToSol(r.leader_pnl_lamports);
	const leaderEntry = lamToSol(r.leader_entry_lamports);
	return {
		id: r.id,
		slug: r.slug,
		name: r.name,
		motto: r.motto || null,
		color: r.color,
		network: r.network,
		created_at: iso(r.created_at),
		official: r.official === true,
		members: n(r.members),
		leaders: Array.isArray(r.leaders) ? r.leaders.map((l) => ({ agent_id: l.agent_id, name: l.name || 'Unnamed trader', image: l.image || null })) : [],
		performance: {
			intents: n(r.intents),
			acted,
			copied_sol: round4(n(r.copied_sol)),
			realized_profit_sol: round6(n(r.profit_sol)),
			closed_copies: closed,
			win_rate_pct: closed > 0 ? round2((wins / closed) * 100) : null,
		},
		// What the followed leaders did on-chain since the day this syndicate formed:
		// the edge the group was riding, measurable before any member has copied.
		since_founding: {
			leader_closes: n(r.leader_closes),
			leader_pnl_sol: round4(leaderPnl),
			leader_roi_pct: leaderEntry > 0 ? round2((leaderPnl / leaderEntry) * 100) : null,
		},
		rank: r.rank == null ? null : n(r.rank),
		url: `/syndicates/${r.slug}`,
	};
}

/**
 * A syndicate's standing on the profit board and its rival: the syndicate right
 * above it (the one to catch) or, for the leader of the board, the one right
 * below (the one chasing). PURE.
 * @param {Array<{id:string, slug:string, name:string, color:string, rank:number, performance:{realized_profit_sol:number}}>} rows
 *        board rows carrying their board-wide profit rank (at least the syndicate and its neighbors).
 * @param {string} syndicateId
 * @param {number} total  active syndicates on the board.
 */
export function computeStanding(rows = [], syndicateId, total = rows.length) {
	const me = rows.find((s) => s.id === syndicateId);
	if (!me || me.rank == null) return { rank: null, total, rival: null };
	const ahead = me.rank > 1;
	const other = rows.find((s) => s.rank === (ahead ? me.rank - 1 : me.rank + 1)) || null;
	const rival = other
		? {
			slug: other.slug,
			name: other.name,
			color: other.color,
			url: `/syndicates/${other.slug}`,
			direction: ahead ? 'ahead' : 'behind',
			realized_profit_sol: other.performance.realized_profit_sol,
			gap_sol: round6(Math.abs(other.performance.realized_profit_sol - me.performance.realized_profit_sol)),
		}
		: null;
	return { rank: me.rank, total, rival };
}

// ── Reads ────────────────────────────────────────────────────────────────────

function orderClause(sort) {
	if (sort === 'members') return sql`order by members desc, profit_sol desc, s.created_at asc`;
	if (sort === 'new') return sql`order by s.created_at desc`;
	return sql`order by profit_sol desc, members desc, s.created_at asc`;
}

/**
 * The public board: every active syndicate on a network with its roster size,
 * its group performance from real copy_executions, and its leaders' live record
 * since founding. Ranked by realized group profit unless sorted otherwise.
 */
export async function loadBoard({ network = 'mainnet', sort = 'profit', limit = 24, offset = 0, onlyId = null, rankFrom = null, rankTo = null, leaderId = null } = {}) {
	const lim = Math.min(100, Math.max(1, Math.floor(n(limit)) || 24));
	const off = Math.max(0, Math.floor(n(offset)));
	const rows = await sql`
		with s as (
			select * from copy_syndicates where network = ${network} and status = 'active'
		),
		mem as (
			select m.syndicate_id, count(*)::int as members
			from copy_syndicate_members m
			join s on s.id = m.syndicate_id
			where m.status = 'active'
			group by m.syndicate_id
		),
		perf as (
			select m.syndicate_id,
			       count(*) filter (where e.direction = 'buy')::int as intents,
			       count(*) filter (where e.direction = 'buy' and e.status = 'acted')::int as acted,
			       coalesce(sum(e.planned_sol) filter (where e.direction = 'buy' and e.status = 'acted'), 0) as copied_sol,
			       coalesce(sum(e.planned_sol * (p.realized_pnl_pct / 100.0)) filter (where e.direction = 'buy' and e.status = 'acted' and p.id is not null), 0) as profit_sol,
			       count(*) filter (where e.direction = 'buy' and e.status = 'acted' and p.id is not null)::int as closed_copies,
			       count(*) filter (where e.direction = 'buy' and e.status = 'acted' and p.id is not null and p.realized_pnl_pct > 0)::int as winning_copies
			from copy_syndicate_members m
			join s on s.id = m.syndicate_id
			join copy_syndicate_member_subs ms on ms.member_id = m.id
			join copy_executions e on e.subscription_id = ms.subscription_id
			     and e.created_at >= m.joined_at and (m.left_at is null or e.created_at < m.left_at)
			left join agent_sniper_positions p on p.id = e.leader_position_id
			     and p.status = 'closed' and p.realized_pnl_pct is not null
			group by m.syndicate_id
		),
		lead as (
			select l.syndicate_id,
			       json_agg(json_build_object('agent_id', a.id, 'name', a.name,
			                'image', coalesce(a.avatar_url, a.profile_image_url)) order by l.position) as leaders,
			       bool_or(a.user_id = s.founder_user_id) as official
			from copy_syndicate_leaders l
			join s on s.id = l.syndicate_id
			join agent_identities a on a.id = l.leader_agent_id
			group by l.syndicate_id
		),
		since as (
			select l.syndicate_id,
			       count(p.id)::int as leader_closes,
			       coalesce(sum(p.realized_pnl_lamports), 0)::text as leader_pnl_lamports,
			       coalesce(sum(p.entry_quote_lamports), 0)::text as leader_entry_lamports
			from copy_syndicate_leaders l
			join s on s.id = l.syndicate_id
			left join agent_sniper_positions p on p.agent_id = l.leader_agent_id
			     and p.network = s.network and p.status = 'closed' and p.closed_at >= s.created_at
			     and p.buy_sig is not null and p.buy_sig <> ${SIMULATED_SIG}
			group by l.syndicate_id
		),
		ranked as (
			select s.id, s.slug, s.name, s.motto, s.color, s.network, s.created_at,
			       coalesce(mem.members, 0) as members,
			       coalesce(perf.intents, 0) as intents, coalesce(perf.acted, 0) as acted,
			       coalesce(perf.copied_sol, 0) as copied_sol, coalesce(perf.profit_sol, 0) as profit_sol,
			       coalesce(perf.closed_copies, 0) as closed_copies, coalesce(perf.winning_copies, 0) as winning_copies,
			       lead.leaders, coalesce(lead.official, false) as official,
			       coalesce(since.leader_closes, 0) as leader_closes,
			       coalesce(since.leader_pnl_lamports, '0') as leader_pnl_lamports,
			       coalesce(since.leader_entry_lamports, '0') as leader_entry_lamports,
			       row_number() over (order by coalesce(perf.profit_sol, 0) desc, coalesce(mem.members, 0) desc, s.created_at asc) as rank,
			       count(*) over () as total
			from s
			left join mem on mem.syndicate_id = s.id
			left join perf on perf.syndicate_id = s.id
			left join lead on lead.syndicate_id = s.id
			left join since on since.syndicate_id = s.id
		)
		select s.*, count(*) over () as matched from ranked s
		where (${onlyId}::uuid is null or s.id = ${onlyId}::uuid)
		  and (${rankFrom}::int is null or s.rank >= ${rankFrom}::int)
		  and (${rankTo}::int is null or s.rank <= ${rankTo}::int)
		  and (${leaderId}::uuid is null or exists (
		      select 1 from copy_syndicate_leaders fl
		      where fl.syndicate_id = s.id and fl.leader_agent_id = ${leaderId}::uuid))
		${orderClause(sort)}
		limit ${lim} offset ${off}
	`;
	// total counts the whole board (its window runs before the filters above);
	// matched counts the rows those filters let through, for pagination.
	const total = rows.length ? n(rows[0].total) : 0;
	const matched = rows.length ? n(rows[0].matched) : 0;
	return { network, sort, limit: lim, offset: off, total, matched, syndicates: rows.map(shapeBoardRow) };
}

/**
 * Leaders a syndicate can be founded around, with their whole closed record and
 * the copyable verdict. The same universe ghost-copy draws from (public agents
 * with closed round-trips), judged by the same bar a follow must clear.
 */
export async function loadFoundingCandidates(network = 'mainnet', { limit = 12 } = {}) {
	const rows = await sql`
		select a.id, a.name, a.avatar_url, a.profile_image_url,
		       count(p.id)::int as settled,
		       count(p.id) filter (where p.realized_pnl_lamports > 0)::int as wins,
		       max(p.closed_at) as last_close_at
		from agent_identities a
		join agent_sniper_positions p on p.agent_id = a.id
		where a.deleted_at is null and a.is_public <> false
		  and p.network = ${network} and p.status = 'closed' and p.closed_at is not null
		group by a.id, a.name, a.avatar_url, a.profile_image_url
		order by max(p.closed_at) desc
		limit ${Math.min(50, Math.max(1, Math.floor(n(limit)) || 12))}
	`;
	const profiles = await Promise.all(rows.map((r) => leaderCopyProfile(r.id, network)));
	const out = rows.map((r, i) => {
		const profile = profiles[i];
		const eligibility = evaluateLeaderEligibility(profile);
		const settled = n(r.settled);
		return {
			agent_id: r.id,
			name: r.name || 'Unnamed trader',
			image: r.avatar_url || r.profile_image_url || null,
			record: {
				settled: profile.settled,
				win_rate_pct: settled > 0 ? round2((n(r.wins) / settled) * 100) : null,
				realized_pnl_sol: profile.realized_pnl_sol,
				deployed_sol: profile.deployed_sol,
				roi_pct: profile.deployed_sol > 0 ? round2((profile.realized_pnl_sol / profile.deployed_sol) * 100) : null,
				max_drawdown_pct: profile.max_drawdown_pct,
				last_close_at: iso(r.last_close_at),
			},
			copyable: eligibility.eligible,
			unmet: eligibility.unmet.map((u) => u.label),
			trader_url: `/trader/${r.id}`,
			ghost_url: `/ghost-copy?leader=${r.id}&budget=1&window=7d`,
		};
	});
	// Copyable first (a syndicate can only form around them), then most recently active.
	out.sort((a, b) => Number(b.copyable) - Number(a.copyable));
	return { network, requirements: LEADER_ELIGIBILITY, leaders: out };
}

async function syndicateBySlug(slug) {
	if (!slugifyName(slug) || slugifyName(slug) !== slug) return null;
	const [row] = await sql`
		select s.*, u.username as founder_username, u.display_name as founder_display_name
		from copy_syndicates s
		left join users u on u.id = s.founder_user_id
		where s.slug = ${slug}
		limit 1
	`;
	return row || null;
}

async function syndicateLeaders(syndicateId) {
	return sql`
		select l.leader_agent_id, l.position, a.user_id, a.name, a.avatar_url, a.profile_image_url,
		       a.is_public, a.deleted_at
		from copy_syndicate_leaders l
		join agent_identities a on a.id = l.leader_agent_id
		where l.syndicate_id = ${syndicateId}
		order by l.position asc
	`;
}

/** The public syndicate page payload. Returns null for an unknown slug. */
export async function loadSyndicate(slug) {
	const s = await syndicateBySlug(slug);
	if (!s) return null;

	const [leaderRows, roster, counts, curveRows, board] = await Promise.all([
		syndicateLeaders(s.id),
		sql`
			select m.role, m.joined_at, u.username, u.display_name, u.avatar_url
			from copy_syndicate_members m
			join users u on u.id = m.user_id
			where m.syndicate_id = ${s.id} and m.status = 'active'
			order by (m.role = 'founder') desc, m.joined_at asc
			limit 60
		`,
		sql`
			select count(*) filter (where m.status = 'active')::int as members,
			       count(*) filter (where m.status = 'left')::int as alumni,
			       count(distinct m.id) filter (where m.status = 'active' and cs.status = 'active')::int as copying
			from copy_syndicate_members m
			left join copy_syndicate_member_subs ms on ms.member_id = m.id
			left join copy_subscriptions cs on cs.id = ms.subscription_id
			where m.syndicate_id = ${s.id}
		`,
		sql`
			select p.closed_at, e.planned_sol * (p.realized_pnl_pct / 100.0) as profit_sol
			from copy_syndicate_members m
			join copy_syndicate_member_subs ms on ms.member_id = m.id
			join copy_executions e on e.subscription_id = ms.subscription_id
			     and e.created_at >= m.joined_at and (m.left_at is null or e.created_at < m.left_at)
			join agent_sniper_positions p on p.id = e.leader_position_id
			     and p.status = 'closed' and p.realized_pnl_pct is not null
			where m.syndicate_id = ${s.id} and e.direction = 'buy' and e.status = 'acted'
			order by p.closed_at asc
			limit 5000
		`,
		s.status === 'active' ? loadBoard({ network: s.network, onlyId: s.id, limit: 1 }) : Promise.resolve({ syndicates: [], total: 0 }),
	]);

	const profiles = await Promise.all(leaderRows.map((l) => leaderCopyProfile(l.leader_agent_id, s.network)));
	const leaders = leaderRows.map((l, i) => {
		const p = profiles[i];
		const eligibility = evaluateLeaderEligibility(p);
		return {
			agent_id: l.leader_agent_id,
			name: l.name || 'Unnamed trader',
			image: l.avatar_url || l.profile_image_url || null,
			available: l.deleted_at == null && l.is_public !== false,
			record: {
				settled: p.settled,
				realized_pnl_sol: p.realized_pnl_sol,
				deployed_sol: p.deployed_sol,
				roi_pct: p.deployed_sol > 0 ? round2((p.realized_pnl_sol / p.deployed_sol) * 100) : null,
				max_drawdown_pct: p.max_drawdown_pct,
				last_closed_at: p.last_closed_at,
			},
			copyable: eligibility.eligible,
			unmet: eligibility.unmet.map((u) => u.label),
			trader_url: `/trader/${l.leader_agent_id}`,
		};
	});
	const official = leaderRows.some((l) => l.user_id === s.founder_user_id);

	const self = board.syndicates[0] || null;
	// The rival is whoever sits one rank away on the profit board.
	const neighbors = self?.rank
		? (await loadBoard({ network: s.network, rankFrom: Math.max(1, self.rank - 1), rankTo: self.rank + 1, limit: 3 })).syndicates
		: [];
	const standing = computeStanding(neighbors.length ? neighbors : self ? [self] : [], s.id, board.total);
	const curve = buildGroupCurve(curveRows);
	const c = counts[0] || {};

	return {
		syndicate: {
			id: s.id,
			slug: s.slug,
			name: s.name,
			motto: s.motto || null,
			color: s.color,
			network: s.network,
			status: s.status,
			created_at: iso(s.created_at),
			official,
			founder: { username: s.founder_username || null, display_name: s.founder_display_name || null },
			url: `/syndicates/${s.slug}`,
		},
		leaders,
		members: {
			count: n(c.members),
			copying: n(c.copying),
			alumni: n(c.alumni),
			list: roster.map((m) => ({
				username: m.username || null,
				display_name: m.display_name || m.username || 'Member',
				avatar_url: m.avatar_url || null,
				role: m.role,
				joined_at: iso(m.joined_at),
			})),
		},
		performance: {
			...(self?.performance || { intents: 0, acted: 0, copied_sol: 0, realized_profit_sol: 0, closed_copies: 0, win_rate_pct: null }),
			curve,
		},
		since_founding: self?.since_founding || { leader_closes: 0, leader_pnl_sol: 0, leader_roi_pct: null },
		standing,
		joinable: s.status === 'active' && leaders.every((l) => l.available && l.copyable),
	};
}

/** The signed-in viewer's relationship to a syndicate: membership, subscriptions, conflicts. */
export async function loadMembership(userId, slug) {
	const s = await syndicateBySlug(slug);
	if (!s) return null;
	const [leaderRows, mine, subs] = await Promise.all([
		syndicateLeaders(s.id),
		sql`
			select m.id, m.syndicate_id, m.role, m.status, m.joined_at, cs.slug, cs.name
			from copy_syndicate_members m
			join copy_syndicates cs on cs.id = m.syndicate_id
			where m.user_id = ${userId} and m.network = ${s.network} and m.status = 'active'
			limit 1
		`,
		sql`
			select ms.subscription_id, ms.created_by_join, c.leader_agent_id, c.status, c.paused_reason, c.copier_wallet
			from copy_syndicate_members m
			join copy_syndicate_member_subs ms on ms.member_id = m.id
			join copy_subscriptions c on c.id = ms.subscription_id
			where m.user_id = ${userId} and m.syndicate_id = ${s.id} and m.status = 'active'
		`,
	]);
	const active = mine[0] || null;
	const isMember = !!active && active.syndicate_id === s.id;
	const ownsLeader = leaderRows.some((l) => l.user_id === userId);
	return {
		slug: s.slug,
		is_founder: s.founder_user_id === userId,
		owns_leader: ownsLeader,
		member: isMember
			? {
				role: active.role,
				joined_at: iso(active.joined_at),
				subscriptions: subs.map((r) => ({
					subscription_id: r.subscription_id,
					leader_agent_id: r.leader_agent_id,
					status: r.status,
					paused_reason: r.paused_reason || null,
					created_by_join: r.created_by_join,
				})),
				wallet: subs[0]?.copier_wallet || null,
			}
			: null,
		other_syndicate: active && !isMember ? { slug: active.slug, name: active.name, url: `/syndicates/${active.slug}` } : null,
	};
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Found a syndicate around one to three copyable leaders.
 * @returns {Promise<{ok:true, syndicate:object, official:boolean} | {ok:false, status:number, code:string, message:string, extra:object}>}
 */
export async function createSyndicate({ userId, input }) {
	const v = validateSyndicateInput(input);
	if (!v.ok) return fail(400, 'invalid_syndicate', v.error);
	const { name, motto, color, network, leader_agent_ids: leaderIds, slug } = v.value;

	const [{ founded = 0 } = {}] = await sql`
		select count(*)::int as founded from copy_syndicates
		where founder_user_id = ${userId} and network = ${network} and status = 'active'
	`;
	if (n(founded) >= MAX_FOUNDED_PER_NETWORK) {
		return fail(409, 'founder_limit', `You already run ${MAX_FOUNDED_PER_NETWORK} syndicates. Grow the ones you have first.`);
	}

	const agents = await sql`
		select id, user_id, name from agent_identities
		where id = any(${leaderIds}) and deleted_at is null and is_public <> false
	`;
	if (agents.length !== leaderIds.length) return fail(404, 'leader_not_found', 'Every leader must be a public trader.');

	// A syndicate that nobody can join is a dead page, so every leader has to clear
	// the same copyable bar a single follow must clear.
	const profiles = await Promise.all(leaderIds.map((id) => leaderCopyProfile(id, network)));
	const blocked = [];
	leaderIds.forEach((id, i) => {
		const e = evaluateLeaderEligibility(profiles[i]);
		if (!e.eligible) {
			const a = agents.find((x) => x.id === id);
			blocked.push({ agent_id: id, name: a?.name || 'Unnamed trader', unmet: e.unmet.map((u) => u.label) });
		}
	});
	if (blocked.length) {
		return fail(409, 'leader_not_copyable',
			`${blocked.map((b) => b.name).join(', ')} ${blocked.length === 1 ? 'does' : 'do'} not have a copyable record yet.`,
			{ leaders: blocked, requirements: LEADER_ELIGIBILITY });
	}

	let syndicate;
	try {
		[syndicate] = await sql`
			insert into copy_syndicates (slug, name, motto, color, network, founder_user_id)
			values (${slug}, ${name}, ${motto}, ${color}, ${network}, ${userId})
			returning *
		`;
	} catch (err) {
		if (isUniqueViolation(err)) return fail(409, 'name_taken', 'A syndicate with that name already exists. Pick another.');
		throw err;
	}

	try {
		for (let i = 0; i < leaderIds.length; i++) {
			await sql`
				insert into copy_syndicate_leaders (syndicate_id, leader_agent_id, position)
				values (${syndicate.id}, ${leaderIds[i]}, ${i})
			`;
		}
	} catch (err) {
		await sql`delete from copy_syndicates where id = ${syndicate.id}`.catch(() => {});
		throw err;
	}

	await unlockBadge(userId, BADGES.SYNDICATE_FOUNDER, { syndicate: syndicate.slug });
	const official = agents.some((a) => a.user_id === userId);
	return { ok: true, syndicate: { ...syndicate, url: `/syndicates/${syndicate.slug}` }, official };
}

/**
 * Join a syndicate: one real, guarded copy subscription per leader, sized by the
 * member's own rules. A subscription the member already had to a leader is linked,
 * never overwritten, so joining can never silently change caps someone set earlier.
 */
export async function joinSyndicate({ userId, slug, body = {} }) {
	const wallet = String(body.copier_wallet || '').trim();
	if (!BASE58_RE.test(wallet)) return fail(400, 'invalid_wallet', 'Enter the Solana wallet you will copy from.');
	const norm = normalizeSubscriptionInput(body);
	if (!norm.ok) return fail(400, 'invalid_config', norm.error);

	const s = await syndicateBySlug(slug);
	if (!s) return fail(404, 'not_found', 'No such syndicate.');
	if (s.status !== 'active') return fail(409, 'archived', 'This syndicate is no longer taking members.');

	const leaderRows = await syndicateLeaders(s.id);
	if (!leaderRows.length) return fail(409, 'no_leaders', 'This syndicate has no leaders to follow.');
	const owned = leaderRows.find((l) => l.user_id === userId);
	if (owned) {
		return fail(403, 'self_copy', `You run ${owned.name || 'one of these leaders'}, so you cannot copy it. Share this page with your followers instead.`);
	}

	const [current] = await sql`
		select m.id, m.syndicate_id, cs.slug, cs.name
		from copy_syndicate_members m
		join copy_syndicates cs on cs.id = m.syndicate_id
		where m.user_id = ${userId} and m.network = ${s.network} and m.status = 'active'
		limit 1
	`;
	if (current && current.syndicate_id === s.id) return { ok: true, already: true, membership: await loadMembership(userId, slug) };
	if (current) {
		return fail(409, 'already_in_syndicate', `You already ride with ${current.name}. Leave it before joining another.`,
			{ current: { slug: current.slug, name: current.name, url: `/syndicates/${current.slug}` } });
	}

	const leaderIds = leaderRows.map((l) => l.leader_agent_id);
	const existing = await sql`
		select id, leader_agent_id, status from copy_subscriptions
		where copier_user_id = ${userId} and network = ${s.network} and leader_agent_id = any(${leaderIds})
	`;
	const live = new Map(existing.filter((e) => e.status !== 'stopped').map((e) => [e.leader_agent_id, e.id]));

	// Check every leader that needs a NEW subscription before writing anything, so a
	// join either follows the whole syndicate or changes nothing.
	const toCreate = leaderRows.filter((l) => !live.has(l.leader_agent_id));
	const profiles = await Promise.all(toCreate.map((l) => leaderCopyProfile(l.leader_agent_id, s.network)));
	const blocked = [];
	toCreate.forEach((l, i) => {
		const e = evaluateLeaderEligibility(profiles[i]);
		if (!e.eligible) blocked.push({ agent_id: l.leader_agent_id, name: l.name || 'Unnamed trader', unmet: e.unmet.map((u) => u.label) });
	});
	if (blocked.length) {
		return fail(409, 'leader_not_copyable',
			`${blocked.map((b) => b.name).join(', ')} cannot be copied right now, so this syndicate is closed to new members until it clears the bar.`,
			{ leaders: blocked, requirements: LEADER_ELIGIBILITY });
	}

	// Claim the team slot first: the partial unique index is the atomic guard
	// against two concurrent joins putting one copier on two teams.
	let member;
	try {
		[member] = await sql`
			insert into copy_syndicate_members (syndicate_id, user_id, network, role)
			values (${s.id}, ${userId}, ${s.network}, ${s.founder_user_id === userId ? 'founder' : 'member'})
			returning *
		`;
	} catch (err) {
		if (isUniqueViolation(err)) return fail(409, 'already_in_syndicate', 'You already ride with another syndicate. Leave it before joining this one.');
		throw err;
	}

	const created = [];
	const rollback = async () => {
		if (created.length) {
			await sql`
				update copy_subscriptions set status = 'stopped', updated_at = now()
				where id = any(${created}) and copier_user_id = ${userId}
			`.catch(() => {});
		}
		await sql`delete from copy_syndicate_members where id = ${member.id}`.catch(() => {});
	};

	try {
		for (const l of leaderRows) {
			const linkedId = live.get(l.leader_agent_id);
			if (linkedId) {
				await sql`
					insert into copy_syndicate_member_subs (member_id, subscription_id, created_by_join)
					values (${member.id}, ${linkedId}, false)
					on conflict do nothing
				`;
				continue;
			}
			const r = await subscribeCopier({ userId, body: { ...body, leader_agent_id: l.leader_agent_id, network: s.network, copier_wallet: wallet } });
			if (!r.ok) {
				await rollback();
				return fail(r.status, r.code, r.message, r.extra);
			}
			created.push(r.subscription.id);
			await sql`
				insert into copy_syndicate_member_subs (member_id, subscription_id, created_by_join)
				values (${member.id}, ${r.subscription.id}, true)
				on conflict do nothing
			`;
		}
	} catch (err) {
		await rollback();
		throw err;
	}

	await unlockBadge(userId, BADGES.SYNDICATE_MEMBER, { syndicate: s.slug });
	return { ok: true, already: false, membership: await loadMembership(userId, slug) };
}

/**
 * Leave a syndicate. Stops only the subscriptions the join created; any
 * subscription the member already had before joining keeps running untouched.
 */
export async function leaveSyndicate({ userId, slug }) {
	const s = await syndicateBySlug(slug);
	if (!s) return fail(404, 'not_found', 'No such syndicate.');
	const [member] = await sql`
		select id from copy_syndicate_members
		where syndicate_id = ${s.id} and user_id = ${userId} and status = 'active'
		limit 1
	`;
	if (!member) return fail(404, 'not_member', 'You are not in this syndicate.');

	const links = await sql`
		select subscription_id, created_by_join from copy_syndicate_member_subs where member_id = ${member.id}
	`;
	const ownIds = links.filter((l) => l.created_by_join).map((l) => l.subscription_id);
	const stopped = ownIds.length
		? await sql`
			update copy_subscriptions set status = 'stopped', updated_at = now()
			where id = any(${ownIds}) and copier_user_id = ${userId} and status <> 'stopped'
			returning id
		`
		: [];
	await sql`
		update copy_syndicate_members set status = 'left', left_at = now()
		where id = ${member.id}
	`;
	return {
		ok: true,
		stopped_subscriptions: stopped.map((r) => r.id),
		kept_subscriptions: links.filter((l) => !l.created_by_join).map((l) => l.subscription_id),
	};
}
