// @ts-check
// Photo-seeded Avaturn lane — turns a generated *diverse face* into a distinct,
// fully-rigged Avaturn avatar. This is what makes the seeded gallery read as
// genuinely different people (girls, guys, young, old, every complexion) instead
// of the same base face in different outfits.
//
// Flow: pickDiversityProfile → faceGenPrompts → text→image (FLUX) → an Avaturn
// v2 session created from that face → the headless harness drives the session
// and exports the rigged GLB (exportRandomAvaturnAvatar({ sessionUrl })).
//
// Avaturn v2 reconstructs from a single frontal, so we generate one on-model
// face and present it as the session's photo. The caller falls back to the
// public-catalog lane if any step here fails, so seeding never stalls.

import { env } from './env.js';
import { textToImage } from '../_mcp3d/text-to-image.js';
import { faceGenPrompts } from './avaturn-seed.js';

const FACE_FETCH_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 30_000;

/** Fetch a generated image URL and inline it as a base64 data URL for Avaturn. */
async function toDataUrl(imageUrl) {
	if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) return imageUrl;
	const r = await fetch(imageUrl, { signal: AbortSignal.timeout(FACE_FETCH_TIMEOUT_MS) });
	if (!r.ok) throw new Error(`face image fetch ${r.status}`);
	const buf = Buffer.from(await r.arrayBuffer());
	const ct = (r.headers.get('content-type') || '').toLowerCase();
	const mime = ct.includes('png') ? 'image/png' : 'image/jpeg';
	return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Generate one photorealistic face for a diversity profile and return it as the
 * frontal/left/right photo set Avaturn's session API expects (the same on-model
 * frontal drives all three — v2 reconstructs from a single photo).
 *
 * @param {import('./avaturn-seed.js').ReturnType<typeof import('./avaturn-seed.js').pickDiversityProfile>} profile
 * @returns {Promise<{ frontal: string, left: string, right: string, model: string | null }>}
 */
export async function generateDiverseFace(profile) {
	const prompts = faceGenPrompts(profile);
	const front = await textToImage(prompts.frontal, { aspectRatio: '1:1' });
	if (!front?.imageUrl) throw new Error('face generation produced no image');
	const dataUrl = await toDataUrl(front.imageUrl);
	return { frontal: dataUrl, left: dataUrl, right: dataUrl, model: front.model ?? null };
}

/**
 * Create an Avaturn v2 session from a face photo set. Returns the session URL
 * the headless harness loads. Throws (with a `code`) when the API key is missing
 * or Avaturn rejects the photos — the caller treats that as "fall back".
 *
 * @param {{ photos: { frontal: string, left: string, right: string }, bodyType?: 'male'|'female', externalUserId: string }} opts
 * @returns {Promise<string>}
 */
export async function createAvaturnSession({ photos, bodyType = 'male', externalUserId }) {
	if (!env.AVATURN_API_KEY) {
		throw Object.assign(new Error('AVATURN_API_KEY unset'), { code: 'not_configured' });
	}
	const r = await fetch(`${env.AVATURN_API_URL}/api/v1/sessions`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.AVATURN_API_KEY}`,
			'content-type': 'application/json',
			accept: 'application/json',
		},
		body: JSON.stringify({
			external_user_id: externalUserId,
			photos,
			body_type: bodyType,
			version: 'v2',
		}),
		signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
	});
	if (!r.ok) {
		const text = await r.text().catch(() => '');
		throw Object.assign(new Error(`avaturn session ${r.status}: ${text.slice(0, 180)}`), {
			code: r.status === 401 ? 'upstream_auth' : 'upstream_error',
		});
	}
	const data = await r.json().catch(() => null);
	const sessionUrl = data?.session_url || data?.url || data?.iframe_url;
	if (!sessionUrl) throw new Error('avaturn session response missing url');
	return sessionUrl;
}

/** Whether the photo lane can run (API key present). */
export function photoLaneConfigured() {
	return !!env.AVATURN_API_KEY;
}
