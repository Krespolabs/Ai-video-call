// Pure shaping helpers for the free text→3D endpoint (api/v1/ai/text-to-3d.js).
//
// Kept dependency-free on purpose: the response contract for the draft lane
// (inline-done vs queued) and the quota/upsell shape are the parts most worth
// pinning in tests, and isolating them here lets those tests exercise the
// contract without dragging in the gateway/auth/db import chain.

export const DAILY_QUOTA = 10;
export const PROMPT_MIN = 3;
export const PROMPT_MAX = 1000;
export const PAID_FORGE_ENDPOINT = '/api/x402/forge';

// Viewer deep-link for a finished GLB — the same format the studio uses
// (`/viewer?src=<encoded glb url>`), reproduced here so this module stays
// import-free.
export function viewerLink(base, glbUrl) {
	return `${base}/viewer?src=${encodeURIComponent(glbUrl)}`;
}

// Translate a /api/forge draft-lane payload into the versioned response
// contract. Inline finish → a done payload with a viewer link; otherwise a
// pending payload carrying the signed job token and the existing free poll URL.
export function shapeResult(job, base) {
	const glbUrl = typeof job?.glb_url === 'string' ? job.glb_url : '';
	if (job?.status === 'done' && glbUrl) {
		return {
			status: 'done',
			glb_url: glbUrl,
			viewer_url: viewerLink(base, glbUrl),
			creation_id: job.creation_id ?? null,
			backend: 'nvidia',
			tier: 'draft',
		};
	}
	const token = job?.job_id ?? null;
	return {
		status: 'pending',
		job: token,
		poll_url: token ? `/api/forge?job=${encodeURIComponent(token)}` : null,
		viewer_url: null,
		backend: 'nvidia',
		tier: 'draft',
	};
}

// Seconds until the daily quota resets, from a limiter result. Floored at 1 so
// Retry-After / X-RateLimit-Reset never advertise 0.
export function resetSeconds(rl, now) {
	return Math.max(1, Math.ceil(((rl?.reset ?? now) - now) / 1000));
}

// The JSON body for an over-quota 429 — an honest rate-limit notice that points
// at the paid forge tiers instead of paywalling silently.
export function quotaBody(rl, resetSec) {
	return {
		error: 'quota_exceeded',
		error_description: `Free text→3D is capped at ${DAILY_QUOTA} generations per day per IP. Your quota resets in ${resetSec}s.`,
		retry_after: resetSec,
		reset_seconds: resetSec,
		quota: { limit: rl?.limit ?? DAILY_QUOTA, window: '24h' },
		upgrade: {
			message: 'Need higher volume or quality? The paid forge tiers have no daily cap.',
			endpoint: PAID_FORGE_ENDPOINT,
			docs: '/docs/api-reference',
		},
	};
}
