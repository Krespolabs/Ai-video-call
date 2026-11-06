// Featured builds store (R20) — the share-a-build half of the /play sandbox.
//
// When a player screenshots their voxel build and publishes it, it lands here:
// a small per-coin "featured builds" surface that links back into the world.
// This reuses the SAME persistence layer as the rest of /play (Upstash Redis,
// the R17 layer the multiplayer block-store writes to) — no new provider.
//
// Layout, kept small so each value stays well under Redis's per-value ceiling:
//   - `featured-builds:<mint>` → a JSON array of lightweight index entries
//     { id, title, author, blocks, createdAt }, newest first, capped to MAX_FEATURED.
//   - `play-build:<id>`        → the full record incl. the screenshot thumbnail,
//     with a TTL so an entry that ages out of the index doesn't leak forever.
//
// Reads fan the index in over one mget; a build whose per-build key has expired
// is simply dropped from the result, so the index self-heals.

import { env } from './env.js';
import { getRedis } from './redis.js';

const INDEX_PREFIX = 'featured-builds:';
const BUILD_PREFIX = 'play-build:';
const MAX_FEATURED = 12;            // builds kept per coin
const BUILD_TTL_SEC = 60 * 60 * 24 * 45; // 45 days — long-lived, but self-expiring

function redis() { return getRedis(); }

function indexKey(mint) { return INDEX_PREFIX + mint; }
function buildKey(id) { return BUILD_PREFIX + id; }

function parse(v) {
	if (v == null) return null;
	if (typeof v !== 'string') return v; // Upstash may auto-parse JSON
	try { return JSON.parse(v); } catch { return null; }
}

// List a coin's featured builds, newest first, each with its screenshot. Tolerant
// of a Redis outage / missing index: returns [] rather than throwing so the
// surface always renders (its empty state covers the no-data case).
export async function listBuilds(mint) {
	const r = redis();
	if (!r || !mint) return [];
	let index;
	try {
		index = parse(await r.get(indexKey(mint)));
	} catch (err) {
		console.warn('[builds-store] index read failed:', err?.message);
		return [];
	}
	if (!Array.isArray(index) || index.length === 0) return [];
	let thumbs = [];
	try {
		thumbs = await r.mget(...index.map((e) => buildKey(e.id)));
	} catch (err) {
		console.warn('[builds-store] thumb read failed:', err?.message);
	}
	const out = [];
	index.forEach((entry, i) => {
		const full = parse(thumbs[i]);
		if (!full) return; // expired or missing — drop it (index self-heals on next publish)
		out.push({
			id: entry.id,
			mint,
			title: entry.title || full.title || '',
			author: entry.author || full.author || '',
			blocks: entry.blocks ?? full.blocks ?? 0,
			createdAt: entry.createdAt ?? full.createdAt ?? 0,
			thumb: full.thumb || '',
			coinName: full.coinName || '',
			coinSymbol: full.coinSymbol || '',
		});
	});
	return out;
}

// Publish a build to a coin's featured surface. The caller has already validated
// the payload (mint, title/author lengths, thumb format + size). Returns the
// stored index entry. Throws only on a hard Redis failure the endpoint surfaces
// as a 5xx.
export async function publishBuild(mint, { id, title, author, blocks, thumb, coinName, coinSymbol, createdAt }) {
	const r = redis();
	if (!r) throw new Error('persistence_unavailable');
	const record = { id, mint, title, author, blocks, thumb, coinName, coinSymbol, createdAt };
	await r.set(buildKey(id), JSON.stringify(record), { ex: BUILD_TTL_SEC });

	const entry = { id, title, author, blocks, createdAt };
	let index = [];
	try { index = parse(await r.get(indexKey(mint))) || []; } catch { index = []; }
	if (!Array.isArray(index)) index = [];
	index.unshift(entry);
	// Trim to the cap; drop the per-build keys of anything evicted so they don't
	// linger past their usefulness (TTL would eventually clear them anyway).
	const evicted = index.slice(MAX_FEATURED);
	index = index.slice(0, MAX_FEATURED);
	await r.set(indexKey(mint), JSON.stringify(index));
	if (evicted.length) {
		try { await r.del(...evicted.map((e) => buildKey(e.id))); } catch { /* best-effort */ }
	}
	return entry;
}
