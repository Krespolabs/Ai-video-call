// GET /api/agents/showrunner
// ---------------------------
// The live wall's "showrunner": a cached, server-side aggregate of the real
// cross-agent ranking signals that program /agents-live like a broadcast
// channel. The client (src/showrunner.js) layers its own live truth on top
// (which cards are actually casting right now, fresh trades it ingests per
// card) and ranks the merged set — so this endpoint never needs to know what a
// given viewer has live.
//
// It blends three REAL sources, never a hardcoded id or sample:
//   1. featured — the SAME deterministic revenue→newest pick /api/agents/featured
//      returns, so the spotlight's "Featured" beat traces to real revenue.
//   2. notable feed events — a slice of the capped feed:events list filtered to
//      the agent-attributable types that carry an agentId (agent-deploy,
//      agent-onchain). Each becomes a spotlight candidate with a reason + ts so
//      the client can caption "newest forge" / "verified on-chain".
//   3. popular roster — the top public agents by real usage, seeding the grid
//      order so active agents float above a quiet tail.
//
// Returns a normalized program:
//   { spotlightCandidates: [{ agentId, name, reason, kind, magnitude, ts }],
//     programOrder: [agentId…], generatedAt, degraded }
//
// Degrades gracefully: any failing source is skipped and the endpoint still
// answers 200 (with degraded:true if it lost a source) so the wall keeps
// working — the client falls back to its own live-truth ranking.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { readFeedEvents } from '../_lib/feed.js';

// Feed types that name a specific agent we can match to a wall card, mapped to
// the spotlight reason/kind the client renders. coin-buy carries a magnitude but
// NO agentId, so it can't be attributed here — the client surfaces "biggest
// trade" itself from the per-card trade frames it already ingests.
const NOTABLE = {
	'agent-deploy':  { kind: 'forge',  reason: 'newest forge',      magnitude: 1 },
	'agent-onchain': { kind: 'verify', reason: 'verified on-chain', magnitude: 2 },
};

const NOTABLE_MAX = 12;   // most recent agent-attributable events to surface
const POPULAR_MAX = 24;   // grid-order seed length

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let degraded = false;

	// 1. featured pick — same rule as /api/agents/featured (revenue 30d → newest).
	const featuredPromise = sql`
		WITH revenue AS (
			SELECT re.agent_id, SUM(re.net_amount)::bigint AS net_total
			FROM agent_revenue_events re
			WHERE re.created_at > now() - interval '30 days'
			GROUP BY re.agent_id
		)
		SELECT i.id, i.name, COALESCE(r.net_total, 0)::bigint AS net_total
		FROM agent_identities i
		LEFT JOIN revenue r ON r.agent_id = i.id
		WHERE i.deleted_at IS NULL AND i.is_public = true
		ORDER BY net_total DESC, i.created_at DESC
		LIMIT 1
	`.then((rows) => rows[0] || null).catch(() => { degraded = true; return null; });

	// 2. popular roster — real usage-ranked public agents (grid-order seed).
	const popularPromise = sql`
		SELECT i.id, i.name,
			COALESCE((
				SELECT count(*)::int FROM usage_events ue
				WHERE ue.agent_id = i.id AND ue.kind = 'llm'
			), 0) AS chat_count
		FROM agent_identities i
		WHERE i.deleted_at IS NULL AND i.is_public = true
		ORDER BY chat_count DESC NULLS LAST, i.created_at DESC
		LIMIT ${POPULAR_MAX}
	`.catch(() => { degraded = true; return []; });

	// 3. notable feed events — agent-attributable, newest-first.
	const feedPromise = readFeedEvents(80).catch(() => { degraded = true; return []; });

	const [featured, popular, feed] = await Promise.all([featuredPromise, popularPromise, feedPromise]);

	// Build spotlight candidates, deduped by agentId (a notable event beats the
	// featured/popular fallbacks for the same agent — the client re-ranks anyway).
	const byAgent = new Map();
	const add = (c) => {
		if (!c || !c.agentId) return;
		const prev = byAgent.get(c.agentId);
		// Keep the richest reason: notable > featured > popular (priority by `rank`).
		if (!prev || (c.rank || 0) > (prev.rank || 0)) byAgent.set(c.agentId, c);
	};

	let notableCount = 0;
	for (const ev of feed || []) {
		if (notableCount >= NOTABLE_MAX) break;
		const m = ev && NOTABLE[ev.type];
		const agentId = ev && (ev.agentId || ev.agent_id);
		if (!m || !agentId) continue;
		notableCount++;
		add({
			agentId,
			name: ev.name || ev.actor || null,
			reason: m.reason,
			kind: m.kind,
			magnitude: m.magnitude,
			ts: Number(ev.ts) || Date.now(),
			rank: 3,
		});
	}

	if (featured) {
		add({
			agentId: featured.id,
			name: featured.name || null,
			reason: 'featured',
			kind: 'featured',
			magnitude: Number(featured.net_total) > 0 ? 1 : 0,
			ts: 0,
			rank: 2,
		});
	}

	const popularIds = [];
	for (const p of popular || []) {
		if (!p || !p.id) continue;
		popularIds.push(p.id);
		add({
			agentId: p.id,
			name: p.name || null,
			reason: 'popular',
			kind: 'popular',
			magnitude: 0,
			ts: 0,
			rank: 1,
		});
	}

	const spotlightCandidates = [...byAgent.values()].map(({ rank, ...c }) => c);

	// programOrder seeds the grid: notable agents first (recency order, already
	// newest-first from the feed scan), then the featured pick, then the popular
	// tail. The client re-orders live agents above this, but the seed guarantees
	// genuinely active agents float up even before any caster is casting.
	const order = [];
	const pushed = new Set();
	const pushId = (id) => { if (id && !pushed.has(id)) { pushed.add(id); order.push(id); } };
	for (const c of spotlightCandidates) if (c.kind === 'forge' || c.kind === 'verify') pushId(c.agentId);
	if (featured) pushId(featured.id);
	for (const id of popularIds) pushId(id);

	return json(
		res,
		200,
		{
			spotlightCandidates,
			programOrder: order,
			generatedAt: new Date().toISOString(),
			degraded,
		},
		// Cheap shared-edge cache: the program shifts on the order of seconds, and
		// the client layers live truth on top, so ~10s of CDN staleness is invisible
		// and keeps the DB/Redis read burn bounded under wall-scale traffic.
		{ 'cache-control': 'public, max-age=8, s-maxage=10, stale-while-revalidate=30' },
	);
});
