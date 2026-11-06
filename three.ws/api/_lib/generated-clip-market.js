// @ts-check
// The generated animation collection as a marketplace product line.
//
// Generated clips (gen-*, api/_lib/motion-seed.js) are listed in animation_clips
// under the platform's own account, so they surface in GET
// /api/marketplace/animations and sell through the existing x402 route
// (api/x402/animation-download.js) exactly like a creator listing. What is sold
// is the motion baked onto the platform rig as one portable GLB
// (api/_lib/motion-glb.js); the clip JSON stays public and free, because it is
// what drives every avatar on the site.
//
// POLICY (docs/animation-seeding.md, "Pricing and the rotating free subset"):
// every generated listing carries the Animation Bazaar's advertised price, and a
// fixed-size subset is free for one epoch at a time. The subset is decided at
// READ time by hashing each clip's name with the epoch number (freeClipNames),
// so the stored price never changes, every server instance agrees without a
// database write, and the free slot rotates on its own every week.
//
// A listing counts as generated only when BOTH hold: it is owned by the platform
// account and it carries the `generated` tag. A creator tagging their own clip
// `generated` does not put it in the rotation, and nothing the platform lists by
// hand is ever given away by accident.

import { sql } from './db.js';
import { freeClipNames, FREE_ROTATION, rotationEpoch } from './motion-seed.js';
import { PLATFORM_AGENT_OWNER_EMAIL } from './custodial-key-health.js';
import { priceFor } from './x402-prices.js';

/** The platform account generated listings are owned by. */
export const PLATFORM_CREATOR_EMAIL = PLATFORM_AGENT_OWNER_EMAIL;
/** Tag that marks a platform listing as part of the generated collection. */
export const GENERATED_TAG = 'generated';
/** Wire format stamped on every generated listing row. */
export const GENERATED_FORMAT = 'three.ws.animation.v1';
/** Where the baked GLBs live in object storage. */
export const GENERATED_GLB_PREFIX = 'animations/library/generated/glb';

/**
 * The listing price in human USDC. It is the Animation Bazaar's advertised
 * price (the same number the route's 402 discovery challenge and
 * /.well-known/x402.json quote), so a generated clip is priced exactly like the
 * product the storefront describes. X402_PRICE_ANIMATION_DOWNLOAD overrides it.
 */
export function generatedListingPrice() {
	return Number(priceFor('animation-download', '10000')) / 1_000_000;
}

/** When the current free epoch ends, as an ISO string. */
export function freeEpochEndsAt(now = Date.now()) {
	return new Date((rotationEpoch(now) + 1) * FREE_ROTATION.EPOCH_MS).toISOString();
}

/**
 * Build the animation_clips row for one generated clip. Pure, so the listing
 * sync and the tests produce the same row.
 *
 * @param {{ name: string, label?: string, category?: string, loop?: boolean, duration?: number }} entry  manifest row
 * @param {{ tracks?: Array<{ times?: ArrayLike<number> }>, duration?: number, userData?: Record<string, any> }} clip  the library clip JSON
 * @param {{ ownerId: string, price: number, artifactKey: string, artifactBytes: number, tags?: string[], take?: number }} listing
 *   `take` numbers the listings of one prompt (1, 2, 3...) so takes that share a
 *   label stay distinguishable; take 1 keeps the bare label.
 */
export function generatedListingRow(entry, clip, { ownerId, price, artifactKey, artifactBytes, tags = [], take = 1 }) {
	const duration = Number(clip?.duration ?? entry.duration ?? 0);
	let frames = 0;
	for (const track of clip?.tracks ?? []) frames = Math.max(frames, track?.times?.length ?? 0);
	const fps = duration > 0 && frames > 1 ? Math.round((frames - 1) / duration) : null;
	const loop = entry.loop === true;
	const category = entry.category || clip?.userData?.category || null;
	const prompt = typeof clip?.userData?.prompt === 'string' ? clip.userData.prompt : '';
	const tagSet = new Set([GENERATED_TAG, ...(category ? [category] : []), ...tags]);
	return {
		owner_id: ownerId,
		slug: entry.name,
		name: take > 1 ? `${entry.label || entry.name} (take ${take})` : entry.label || entry.name,
		description: prompt
			? `Generated on the three.ws motion lane from the prompt "${prompt}". Baked onto the three.ws rig as a GLB.`
			: 'Generated on the three.ws motion lane. Baked onto the three.ws rig as a GLB.',
		kind: loop ? 'loop' : 'animation',
		format: GENERATED_FORMAT,
		duration_ms: Math.round(duration * 1000),
		frame_count: frames,
		fps,
		loop,
		tags: [...tagSet].map((t) => String(t).slice(0, 40)).slice(0, 12),
		visibility: 'public',
		price_amount: price > 0 ? price : null,
		price_currency: price > 0 ? 'USDC' : null,
		artifact_key: artifactKey,
		artifact_bytes: artifactBytes,
		artifact_mime: 'model/gltf-binary',
		listed: true,
	};
}

// ── Read side ────────────────────────────────────────────────────────────────

const CACHE_MS = 5 * 60_000;
let cache = null;

/**
 * The platform account id and the slugs free this epoch. Cached for five
 * minutes and never across an epoch boundary, so a rotation takes effect on
 * time. A missing platform account yields an empty set rather than an error:
 * with no generated listings there is nothing to rotate.
 *
 * @returns {Promise<{ platformId: string|null, free: Set<string>, epoch: number }>}
 */
export async function generatedRotation(now = Date.now()) {
	const epoch = rotationEpoch(now);
	if (cache && cache.epoch === epoch && now - cache.at < CACHE_MS) return cache.value;

	const [owner] = await sql`select id from users where lower(email::text) = ${PLATFORM_CREATOR_EMAIL} limit 1`;
	const platformId = owner?.id ?? null;
	let free = new Set();
	if (platformId) {
		const rows = await sql`
			select slug from animation_clips
			where owner_id = ${platformId} and ${GENERATED_TAG} = any(tags)
			      and listed = true and deleted_at is null and artifact_key is not null
		`;
		free = new Set(freeClipNames(rows.map((r) => r.slug), { now }));
	}
	const value = { platformId, free, epoch };
	cache = { at: now, epoch, value };
	return value;
}

/** Forget the cached rotation (tests, and the listing sync after it writes). */
export function resetGeneratedRotationCache() {
	cache = null;
}

/**
 * True when this row is a generated listing that is free this epoch.
 *
 * @param {{ owner_id?: string, slug?: string, tags?: string[] }} row
 * @param {{ platformId: string|null, free: Set<string> }} rotation
 */
export function isFreeGeneratedListing(row, rotation) {
	if (!rotation?.platformId || row?.owner_id !== rotation.platformId) return false;
	if (!Array.isArray(row.tags) || !row.tags.includes(GENERATED_TAG)) return false;
	return rotation.free.has(String(row.slug));
}
