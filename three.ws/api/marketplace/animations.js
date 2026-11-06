// GET /api/marketplace/animations — the marketplace feed of creator-listed
// avatar animations.
//
// Surfaces animation_clips where listed = true: clips a creator priced + staged
// an animated GLB for, via api/animations/sell.js. Each row carries its price,
// thumbnail, creator, and the x402 download route the buyer pays against
// (api/x402/animation-download.js). Read-only + public — no auth required.
//
//   ?q=          full-text-ish match on name / description
//   ?tag=        single tag filter
//   ?kind=       animation | loop | sequence
//   ?price=      free | paid
//   ?sort=       recent (default) | popular | price_low | price_high
//   ?limit=      1..60 (default 24)
//   ?cursor=     opaque pagination cursor
//
// The platform's generated collection (api/_lib/generated-clip-market.js) is
// listed here too, under the platform account. A rotating subset of it is free
// for the current week: those rows report `free: true` with `free_rotation`
// set, and the price filters and price sorts treat them as free.

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { isUuid } from '../_lib/validate.js';
import {
	freeEpochEndsAt,
	generatedRotation,
	GENERATED_TAG,
	isFreeGeneratedListing,
} from '../_lib/generated-clip-market.js';

// `effective_price` is the price a buyer pays right now: the stored price,
// except for a generated listing in this week's free rotation (see
// rotationFreeSql below).
const SORTS = {
	recent: 'c.created_at desc',
	popular: 'c.purchase_count desc, c.created_at desc',
	price_low: 'effective_price asc nulls first, c.created_at desc',
	price_high: 'effective_price desc nulls last, c.created_at desc',
};

/**
 * SQL that is true for a generated listing free this epoch, appending its
 * parameters to `params`. With no platform account there is no rotation and
 * the predicate is constant false.
 */
function rotationFreeSql(rotation, params) {
	if (!rotation.platformId || rotation.free.size === 0) return 'false';
	params.push(rotation.platformId);
	const owner = params.length;
	params.push(GENERATED_TAG);
	const tag = params.length;
	params.push([...rotation.free]);
	const slugs = params.length;
	return `(c.owner_id = $${owner} and $${tag} = any(c.tags) and c.slug = any($${slugs}::text[]))`;
}

// The rotation is read from the database, so a failure there must not take the
// whole feed down: without it every listing simply reports its stored price.
async function rotationOrNone() {
	try {
		return await generatedRotation();
	} catch (err) {
		console.warn('[marketplace/animations] free rotation unavailable', err?.message || err);
		return { platformId: null, free: new Set(), epoch: 0 };
	}
}

const DOWNLOAD_ROUTE = '/api/x402/animation-download';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');

	// Single-listing lookup (?id=) — public metadata + poster for the purchase
	// modal / deep link. Never returns the baked clip JSON (that's the product).
	const idParam = (url.searchParams.get('id') || '').trim();
	if (idParam) return handleOne(res, idParam);

	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 60);
	const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
	const tag = (url.searchParams.get('tag') || '').trim().slice(0, 40);
	const kind = url.searchParams.get('kind');
	const price = url.searchParams.get('price');
	const sort = SORTS[url.searchParams.get('sort')] || SORTS.recent;
	const cursor = url.searchParams.get('cursor');

	// Positional-parameter WHERE — the Neon client doesn't interpolate nested
	// sql`` fragments (same pattern as api/animations/clips.js).
	const rotation = await rotationOrNone();
	const params = [];
	const rotationFree = rotationFreeSql(rotation, params);
	const effectivePrice = `(case when ${rotationFree} then null else c.price_amount end)`;
	const conds = ['c.listed = true', 'c.deleted_at is null', 'c.artifact_key is not null'];

	if (q) {
		params.push(`%${q}%`);
		conds.push(`(c.name ilike $${params.length} or c.description ilike $${params.length})`);
	}
	if (tag) {
		params.push(tag);
		conds.push(`$${params.length} = any(c.tags)`);
	}
	if (kind && /^[a-z]+$/.test(kind)) {
		params.push(kind);
		conds.push(`c.kind = $${params.length}`);
	}
	if (price === 'free') conds.push(`(${effectivePrice} is null or ${effectivePrice} <= 0)`);
	if (price === 'paid') conds.push(`${effectivePrice} > 0`);
	if (cursor) {
		const decoded = decodeCursor(cursor);
		if (decoded) {
			params.push(decoded.createdAt);
			conds.push(`c.created_at < $${params.length}`);
		}
	}
	params.push(limit + 1);

	let rows;
	try {
		rows = await sql(
			`select c.id, c.owner_id, c.slug, c.name, c.description, c.kind, c.duration_ms,
			        c.frame_count, c.fps, c.loop, c.tags, c.thumbnail_key,
			        c.price_amount, c.price_currency, c.artifact_bytes,
			        c.play_count, c.purchase_count, c.created_at,
			        ${effectivePrice} as effective_price,
			        u.display_name as creator_name, u.username as creator_username,
			        u.avatar_url as creator_avatar
			 from animation_clips c
			 left join users u on u.id = c.owner_id
			 where ${conds.join(' and ')}
			 order by ${sort}
			 limit $${params.length}`,
			params,
		);
	} catch (err) {
		console.error('[marketplace/animations]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to load animations');
	}

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const items = page.map((row) => shape(row, rotation));
	const nextCursor = hasMore ? encodeCursor({ createdAt: rows[limit - 1].created_at }) : null;

	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { items, next_cursor: nextCursor });
});

async function handleOne(res, id) {
	if (!isUuid(id)) return error(res, 400, 'invalid_request', 'id must be a uuid');
	let row;
	try {
		[row] = await sql`
			select c.id, c.owner_id, c.slug, c.name, c.description, c.kind, c.duration_ms,
			       c.frame_count, c.fps, c.loop, c.tags, c.thumbnail_key,
			       c.price_amount, c.price_currency, c.artifact_bytes,
			       c.play_count, c.purchase_count, c.created_at,
			       u.display_name as creator_name, u.username as creator_username,
			       u.avatar_url as creator_avatar
			from animation_clips c
			left join users u on u.id = c.owner_id
			where c.id = ${id} and c.listed = true and c.deleted_at is null
			      and c.artifact_key is not null
			limit 1
		`;
	} catch (err) {
		console.error('[marketplace/animations/one]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to load animation');
	}
	if (!row) return error(res, 404, 'not_found', 'animation listing not found');
	const rotation = await rotationOrNone();
	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { item: shape(row, rotation) });
}

function shape(row, rotation = { platformId: null, free: new Set() }) {
	const listPaid = row.price_amount != null && Number(row.price_amount) > 0;
	const rotating = listPaid && isFreeGeneratedListing(row, rotation);
	const paid = listPaid && !rotating;
	const generated = !!rotation.platformId && row.owner_id === rotation.platformId && (row.tags || []).includes(GENERATED_TAG);
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		kind: row.kind,
		duration_ms: row.duration_ms,
		duration: row.duration_ms / 1000,
		frame_count: row.frame_count,
		fps: row.fps,
		loop: row.loop,
		tags: row.tags || [],
		thumbnail_url: thumbnailUrl(row.thumbnail_key),
		price: paid ? { amount: String(row.price_amount), currency: row.price_currency || 'USDC' } : null,
		free: !paid,
		// Set only while a generated listing is in this week's free rotation:
		// what it normally costs, and when the rotation moves on.
		free_rotation: rotating
			? { regular_price: { amount: String(row.price_amount), currency: row.price_currency || 'USDC' }, until: freeEpochEndsAt() }
			: null,
		generated,
		size_bytes: row.artifact_bytes != null ? Number(row.artifact_bytes) : null,
		play_count: Number(row.play_count || 0),
		purchase_count: Number(row.purchase_count || 0),
		download_url: `${DOWNLOAD_ROUTE}?id=${row.id}`,
		creator: {
			name: row.creator_name || row.creator_username || 'Anonymous',
			username: row.creator_username || null,
			avatar_url: row.creator_avatar || null,
		},
		created_at: row.created_at,
	};
}

function encodeCursor({ createdAt }) {
	return Buffer.from(JSON.stringify({ c: createdAt })).toString('base64url');
}
function decodeCursor(cursor) {
	try {
		const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		// A cursor that decodes but carries a timestamp Date cannot read used to
		// reach Postgres as an Invalid Date and take the whole feed down with a 500,
		// and a null one silently paged from the epoch. Both are bad cursors like
		// any other: drop them and serve page one. A real cursor always round-trips
		// created_at as an ISO string.
		if (typeof obj?.c !== 'string' && typeof obj?.c !== 'number') return null;
		const createdAt = new Date(obj.c);
		if (Number.isNaN(createdAt.getTime())) return null;
		return { createdAt };
	} catch {
		return null;
	}
}

export const __test__ = { shape, encodeCursor, decodeCursor, SORTS, rotationFreeSql };
