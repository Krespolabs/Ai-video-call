// api/_lib/avatar-search-warm.js
//
// Warm-cache for the public avatar gallery search pipeline.
//
// Producer: the "Avatar Search Index Warmup" autonomous x402 loop entry
// (api/_lib/x402/autonomous-registry.js → avatar-search-warmup) pays per call to
// /api/mcp (search_public_avatars) for ~20 common queries, then upserts the
// ranked, thumbnail-resolved results here via upsertWarmedSearch().
//
// Consumer: GET /api/avatars/popular-searches reads getPopularSearches() to power
// "popular search" suggestion chips (with sample thumbnails) on the gallery.
//
// Table DDL lives in 20260629100000_avatar_search_warm_cache.sql; ensureSchema()
// creates it lazily so run() can be exercised before db:migrate has run.

import { sql } from './db.js';

let _ensured = false;

export async function ensureWarmCacheSchema() {
	if (_ensured) return;
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS avatar_search_warm_cache (
				query          text PRIMARY KEY,
				result_count   integer NOT NULL DEFAULT 0,
				top_results    jsonb NOT NULL DEFAULT '[]'::jsonb,
				thumbnails     text[] NOT NULL DEFAULT '{}',
				has_thumbnails boolean NOT NULL DEFAULT false,
				warmed_at      timestamptz NOT NULL DEFAULT now(),
				run_id         uuid
			)
		`;
		await sql`
			CREATE INDEX IF NOT EXISTS avatar_search_warm_cache_rank
				ON avatar_search_warm_cache (result_count DESC, warmed_at DESC)
		`;
		_ensured = true;
	} catch { /* already exists or applied by the migration system */ }
}

/**
 * Upsert one warmed query's ranked results. `topResults` is the trimmed,
 * render-ready slice ([{ id, name, slug, thumbnail_url }]); `thumbnails` is the
 * non-null thumbnail URLs from that slice (used to validate the pipeline
 * resolved imagery and to paint suggestion chips).
 * @returns {Promise<boolean>} true on write
 */
export async function upsertWarmedSearch({ query, resultCount, topResults, thumbnails, runId }) {
	const q = String(query || '').trim();
	if (!q) return false;
	const results = Array.isArray(topResults) ? topResults : [];
	const thumbs = Array.isArray(thumbnails) ? thumbnails.filter(Boolean) : [];
	try {
		await sql`
			INSERT INTO avatar_search_warm_cache
				(query, result_count, top_results, thumbnails, has_thumbnails, warmed_at, run_id)
			VALUES
				(${q}, ${Number(resultCount) || 0}, ${JSON.stringify(results)}::jsonb,
				 ${thumbs}, ${thumbs.length > 0}, now(), ${runId || null})
			ON CONFLICT (query) DO UPDATE SET
				result_count   = EXCLUDED.result_count,
				top_results    = EXCLUDED.top_results,
				thumbnails     = EXCLUDED.thumbnails,
				has_thumbnails = EXCLUDED.has_thumbnails,
				warmed_at      = now(),
				run_id         = EXCLUDED.run_id
		`;
		return true;
	} catch {
		return false;
	}
}

/**
 * Popular warmed searches, ranked by how much public inventory each surfaces.
 * Returns [] when the table is empty or absent (cold start) so the consumer
 * endpoint degrades to a static fallback rather than erroring.
 * @param {{ limit?: number, withThumbnails?: boolean }} [opts]
 */
export async function getPopularSearches({ limit = 12, withThumbnails = false } = {}) {
	const lim = Math.min(Math.max(Number(limit) || 12, 1), 50);
	try {
		const rows = await sql`
			SELECT query, result_count, thumbnails, has_thumbnails, warmed_at, top_results
			FROM avatar_search_warm_cache
			WHERE result_count > 0
			ORDER BY result_count DESC, warmed_at DESC
			LIMIT ${lim}
		`;
		return rows.map((r) => ({
			query: r.query,
			result_count: Number(r.result_count) || 0,
			thumbnails: Array.isArray(r.thumbnails) ? r.thumbnails.slice(0, 4) : [],
			sample_thumbnail: Array.isArray(r.thumbnails) ? (r.thumbnails[0] || null) : null,
			top_results: withThumbnails ? (r.top_results || []) : [],
			warmed_at: r.warmed_at,
		}));
	} catch {
		return [];
	}
}
