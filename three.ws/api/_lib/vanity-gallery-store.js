/**
 * Persistence for the proof-of-grind gallery + leaderboard.
 *
 * Stores ONLY opt-in, public, secret-free rarity entries: the public Base58
 * address, the matched pattern, the honest rarity breakdown, the signed-receipt
 * fingerprint (so an entry is provably tied to a verifiable grind), and the
 * service signature over that receipt. It NEVER stores — and `toPublicEntry()`
 * structurally cannot serialize — a private key, seed, serverSeed, sealed
 * envelope, or any field outside the explicit allowlist below. Privacy is a
 * property of the data model, not of careful callers.
 *
 * Backing store mirrors the rest of the codebase: Upstash Redis when configured,
 * an in-process Map fallback otherwise (so local/CI works and a Redis outage
 * degrades to empty rather than throwing). Layout:
 *
 *   HASH  vanity:gallery:entries          field=address → JSON(public entry)
 *   ZSET  vanity:gallery:by-score         member=address  score=rarityScore
 *   ZSET  vanity:gallery:by-recency       member=address  score=ts(ms)
 *   ZSET  vanity:gallery:tier:<tier>      member=address  score=rarityScore
 *
 * The leaderboard is `by-score` (rev), the gallery default is `by-recency` (rev),
 * tier filters use the per-tier ZSETs, and length/pattern filters are applied in
 * memory over a bounded page window. Idempotent on address: re-publishing the
 * same address updates in place (so an agent that re-grinds keeps one entry).
 */

import { getRedis } from './redis.js';

const NS = 'vanity:gallery';
const K = {
	entries: `${NS}:entries`,
	byScore: `${NS}:by-score`,
	byRecency: `${NS}:by-recency`,
	tier: (t) => `${NS}:tier:${t}`,
};

// Hard ceiling so a malicious flood can't unbound a scan. The public list paginates
// under this; the leaderboard reads the top slice directly from the ZSET.
const MAX_SCAN = 1000;

// The EXACT fields a public gallery entry may carry. Anything not here is dropped.
// SECURITY: this allowlist is the privacy boundary — no secret/seed/sealed field
// is on it, so even a caller that passes a full grind response cannot leak one.
const PUBLIC_FIELDS = Object.freeze([
	'address',
	'pattern',
	'rarityScore',
	'rarityBits',
	'baseBits',
	'bonusBits',
	'tier',
	'tierLabel',
	'expectedAttempts',
	'attempts',
	'durationMs',
	'bonuses',
	'label',
	'commitment',
	'receiptFingerprint',
	'servicePublicKey',
	'verified',
	'network',
	'ts',
]);

const mem = new Map(); // address → entry (fallback store)

/**
 * Project any object down to the public, secret-free entry shape. This is the
 * only path data takes into the store, so secrets are structurally impossible to
 * persist. Returns null when the entry lacks the minimum required fields.
 * @param {object} obj
 * @returns {object|null}
 */
export function toPublicEntry(obj) {
	if (!obj || typeof obj !== 'object') return null;
	const out = {};
	for (const k of PUBLIC_FIELDS) if (obj[k] !== undefined) out[k] = obj[k];
	if (!out.address || typeof out.address !== 'string') return null;
	if (typeof out.rarityScore !== 'number') return null;
	// Defensive: strip any nested secret-looking keys that somehow rode along on a
	// permitted object field (e.g. a `pattern` that was over-populated upstream).
	out.pattern = sanitizePattern(out.pattern);
	if (Array.isArray(out.bonuses)) {
		out.bonuses = out.bonuses.slice(0, 8).map((b) => ({
			id: String(b?.id || ''),
			label: String(b?.label || ''),
			bits: Number(b?.bits) || 0,
		}));
	}
	if (out.label != null) out.label = String(out.label).slice(0, 80);
	return out;
}

function sanitizePattern(p) {
	if (!p || typeof p !== 'object') return { prefix: null, suffix: null, ignoreCase: false };
	return {
		prefix: p.prefix ? String(p.prefix).slice(0, 16) : null,
		suffix: p.suffix ? String(p.suffix).slice(0, 16) : null,
		ignoreCase: !!p.ignoreCase,
	};
}

/**
 * Insert/update a public gallery entry. Idempotent on address.
 * @param {object} entry - already projected via toPublicEntry (re-projected here).
 * @returns {Promise<object>} the stored public entry.
 */
export async function putEntry(entry) {
	const pub = toPublicEntry(entry);
	if (!pub) throw Object.assign(new Error('invalid gallery entry'), { status: 400 });
	const addr = pub.address;
	const score = pub.rarityScore;
	const ts = Number(pub.ts) || Date.now();
	pub.ts = ts;

	const redis = getRedis();
	if (redis) {
		// Clear any stale per-tier membership from a previous publish of this addr.
		const prevRaw = await redis.hget(K.entries, addr);
		const prev = parseEntry(prevRaw);
		const pipe = redis.multi();
		if (prev?.tier && prev.tier !== pub.tier) pipe.zrem(K.tier(prev.tier), addr);
		pipe.hset(K.entries, { [addr]: JSON.stringify(pub) });
		pipe.zadd(K.byScore, { score, member: addr });
		pipe.zadd(K.byRecency, { score: ts, member: addr });
		pipe.zadd(K.tier(pub.tier), { score, member: addr });
		await pipe.exec();
	} else {
		mem.set(addr, pub);
	}
	return pub;
}

/** Fetch a single entry by address, or null. */
export async function getEntry(address) {
	const addr = String(address || '');
	if (!addr) return null;
	const redis = getRedis();
	if (redis) return parseEntry(await redis.hget(K.entries, addr));
	return mem.get(addr) || null;
}

/** Remove an entry entirely (owner un-publish). */
export async function removeEntry(address) {
	const addr = String(address || '');
	if (!addr) return false;
	const redis = getRedis();
	if (redis) {
		const prev = parseEntry(await redis.hget(K.entries, addr));
		const pipe = redis.multi();
		pipe.hdel(K.entries, addr);
		pipe.zrem(K.byScore, addr);
		pipe.zrem(K.byRecency, addr);
		if (prev?.tier) pipe.zrem(K.tier(prev.tier), addr);
		await pipe.exec();
		return true;
	}
	return mem.delete(addr);
}

/**
 * Query the gallery / leaderboard.
 * @param {object} [q]
 * @param {'score'|'recency'} [q.sort='recency']
 * @param {string} [q.tier] - filter to one tier id.
 * @param {number} [q.minLength] - min combined pattern length.
 * @param {string} [q.contains] - substring the prefix/suffix must include.
 * @param {number} [q.limit=24]
 * @param {number} [q.offset=0]
 * @returns {Promise<{ entries: object[], total: number, hasMore: boolean }>}
 */
export async function queryEntries(q = {}) {
	const sort = q.sort === 'score' ? 'score' : 'recency';
	const tier = q.tier || null;
	const minLength = Number.isFinite(q.minLength) ? Number(q.minLength) : 0;
	const contains = (q.contains || '').toString().trim().toLowerCase();
	const limit = Math.max(1, Math.min(100, Number(q.limit) || 24));
	const offset = Math.max(0, Number(q.offset) || 0);

	const filtered = matchesFilters.bind(null, { minLength, contains });

	const redis = getRedis();
	let ordered;
	if (redis) {
		// Choose the index ZSET. Tier filter narrows to the per-tier ZSET (always
		// score-ordered); otherwise the requested global index.
		const key = tier ? K.tier(tier) : sort === 'score' ? K.byScore : K.byRecency;
		const members = await redis.zrange(key, 0, MAX_SCAN - 1, { rev: true });
		if (!members.length) return { entries: [], total: 0, hasMore: false };
		const raw = await redis.hmget(K.entries, ...members);
		ordered = members
			.map((m, i) => parseEntry(raw?.[i]))
			.filter((e) => e && (!tier || e.tier === tier) && filtered(e));
		// Per-tier ZSET is score-ordered; honor a recency sort by re-sorting.
		if (tier && sort === 'recency') ordered.sort((a, b) => (b.ts || 0) - (a.ts || 0));
	} else {
		ordered = [...mem.values()]
			.filter((e) => (!tier || e.tier === tier) && filtered(e))
			.sort((a, b) => (sort === 'score' ? b.rarityScore - a.rarityScore : (b.ts || 0) - (a.ts || 0)));
	}

	const total = ordered.length;
	const page = ordered.slice(offset, offset + limit);
	return { entries: page, total, hasMore: offset + limit < total };
}

/** Top-N by rarity, straight off the score ZSET — the leaderboard fast path. */
export async function topByScore(limit = 10) {
	const n = Math.max(1, Math.min(100, Number(limit) || 10));
	const redis = getRedis();
	if (redis) {
		const members = await redis.zrange(K.byScore, 0, n - 1, { rev: true });
		if (!members.length) return [];
		const raw = await redis.hmget(K.entries, ...members);
		return members.map((_, i) => parseEntry(raw?.[i])).filter(Boolean);
	}
	return [...mem.values()].sort((a, b) => b.rarityScore - a.rarityScore).slice(0, n);
}

/** Aggregate counts: total entries + per-tier histogram. */
export async function galleryStats() {
	const redis = getRedis();
	let entries;
	if (redis) {
		const all = await redis.hgetall(K.entries);
		entries = all ? Object.values(all).map(parseEntry).filter(Boolean) : [];
	} else {
		entries = [...mem.values()];
	}
	const byTier = {};
	let rarest = null;
	for (const e of entries) {
		byTier[e.tier] = (byTier[e.tier] || 0) + 1;
		if (!rarest || e.rarityScore > rarest.rarityScore) rarest = e;
	}
	return { total: entries.length, byTier, rarest };
}

function matchesFilters({ minLength, contains }, e) {
	const pre = e.pattern?.prefix || '';
	const suf = e.pattern?.suffix || '';
	if (minLength && pre.length + suf.length < minLength) return false;
	if (contains && !(`${pre}${suf}`.toLowerCase().includes(contains))) return false;
	return true;
}

function parseEntry(raw) {
	if (!raw) return null;
	if (typeof raw === 'object') return raw; // Upstash auto-deserializes JSON
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export { PUBLIC_FIELDS };
