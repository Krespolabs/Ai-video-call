// Tests for the Replicate avatar-reconstruction provider.
//
// Regression cover for the two TRELLIS contract bugs that made the selfie → 3D
// pipeline silently produce nothing:
//   • TRELLIS `generate_model` defaults to FALSE, so the prediction "succeeds"
//     but returns no GLB unless we explicitly ask for one. The provider must
//     send generate_model:true for TRELLIS-family models.
//   • TRELLIS emits the mesh under the `model_file` output key, which the GLB
//     extractor previously ignored. extractGlbUrl must resolve `model_file`.
//
// Also guards the model-awareness boundary: TRELLIS-only flags must NOT leak to
// a non-TRELLIS model (e.g. Hunyuan3D), where they would 422 against its schema.
//
// We stub global fetch to capture the submitted prediction body and to model
// Replicate's predictions API responses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.REPLICATE_API_TOKEN;
const ORIGINAL_RECONSTRUCT = process.env.REPLICATE_RECONSTRUCT_MODEL;
const ORIGINAL_WEBHOOK = process.env.REPLICATE_WEBHOOK_URL;
const ORIGINAL_ORIGIN = process.env.APP_ORIGIN;

async function freshProvider() {
	// Import fresh each time so module-level env reads don't bleed across cases.
	const mod = await import('../../api/_providers/replicate.js?t=' + Math.random());
	return mod.createRegenProvider();
}

// Capture the POST body sent to Replicate and reply with a queued prediction.
function stubSubmit() {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts) => {
		calls.push({ url: String(url), body: JSON.parse(opts.body) });
		return new Response(JSON.stringify({ id: 'pred_123', status: 'starting' }), {
			status: 201,
			headers: { 'content-type': 'application/json' },
		});
	});
	return calls;
}

beforeEach(() => {
	process.env.REPLICATE_API_TOKEN = 'r8_test_token';
	delete process.env.REPLICATE_RECONSTRUCT_MODEL;
	delete process.env.REPLICATE_WEBHOOK_URL;
	delete process.env.APP_ORIGIN;
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	if (ORIGINAL_TOKEN === undefined) delete process.env.REPLICATE_API_TOKEN;
	else process.env.REPLICATE_API_TOKEN = ORIGINAL_TOKEN;
	if (ORIGINAL_RECONSTRUCT === undefined) delete process.env.REPLICATE_RECONSTRUCT_MODEL;
	else process.env.REPLICATE_RECONSTRUCT_MODEL = ORIGINAL_RECONSTRUCT;
	if (ORIGINAL_WEBHOOK === undefined) delete process.env.REPLICATE_WEBHOOK_URL;
	else process.env.REPLICATE_WEBHOOK_URL = ORIGINAL_WEBHOOK;
	if (ORIGINAL_ORIGIN === undefined) delete process.env.APP_ORIGIN;
	else process.env.APP_ORIGIN = ORIGINAL_ORIGIN;
	vi.restoreAllMocks();
});

describe('replicate provider — TRELLIS reconstruct input', () => {
	it('sends generate_model:true (the default model would emit no GLB otherwise)', async () => {
		const calls = stubSubmit();
		const provider = await freshProvider();
		await provider.submit({
			mode: 'reconstruct',
			params: { images: ['https://img/a.jpg'] },
			sourceUrl: 'https://img/a.jpg',
		});
		expect(calls).toHaveLength(1);
		// Default model is the firtoz/trellis slug → /models/.../predictions.
		expect(calls[0].url).toContain('/models/firtoz/trellis/predictions');
		const input = calls[0].body.input;
		expect(input.generate_model).toBe(true);
		expect(input.images).toEqual(['https://img/a.jpg']);
		// Video/ply outputs are disabled to halve GPU cost — we only consume the mesh.
		expect(input.generate_color).toBe(false);
	});

	it('lets caller params override the TRELLIS defaults', async () => {
		const calls = stubSubmit();
		const provider = await freshProvider();
		await provider.submit({
			mode: 'reconstruct',
			params: { images: ['https://img/a.jpg'], generate_color: true, texture_size: 2048 },
			sourceUrl: 'https://img/a.jpg',
		});
		const input = calls[0].body.input;
		expect(input.generate_model).toBe(true); // still forced on
		expect(input.generate_color).toBe(true); // caller wins
		expect(input.texture_size).toBe(2048);
	});

	it('does NOT leak generate_model to a non-TRELLIS model (would 422)', async () => {
		process.env.REPLICATE_RECONSTRUCT_MODEL = 'tencent/hunyuan3d-2';
		const calls = stubSubmit();
		const provider = await freshProvider();
		await provider.submit({
			mode: 'reconstruct',
			params: { images: ['https://img/a.jpg'] },
			sourceUrl: 'https://img/a.jpg',
		});
		const input = calls[0].body.input;
		expect(input).not.toHaveProperty('generate_model');
		expect(input).not.toHaveProperty('generate_color');
		expect(input.images).toEqual(['https://img/a.jpg']);
	});
});

describe('replicate provider — community-model 404 fallback', () => {
	// Replicate 404s the unversioned /models/{owner}/{name}/predictions endpoint
	// for community models (firtoz/trellis included). The provider must resolve
	// the latest published version and retry through POST /predictions, or every
	// default-path image→3D submit dies with "resource could not be found".
	it('resolves the latest version and retries via /predictions on 404', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts = {}) => {
			calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
			const u = String(url);
			if (u.endsWith('/models/firtoz/trellis/predictions')) {
				return new Response(JSON.stringify({ detail: 'The requested resource could not be found.' }), {
					status: 404,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (u.endsWith('/models/firtoz/trellis')) {
				return new Response(JSON.stringify({ latest_version: { id: 'abc123version' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (u.endsWith('/predictions')) {
				return new Response(JSON.stringify({ id: 'pred_456', status: 'starting' }), {
					status: 201,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`unexpected fetch: ${u}`);
		});

		const provider = await freshProvider();
		const job = await provider.submit({
			mode: 'reconstruct',
			params: { images: ['https://img/a.jpg'] },
			sourceUrl: 'https://img/a.jpg',
		});

		expect(job.extJobId).toBe('pred_456');
		const retry = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/predictions'));
		expect(retry).toBeDefined();
		expect(retry.body.version).toBe('abc123version');
		// The retried submission must carry the same model input, TRELLIS flags included.
		expect(retry.body.input.generate_model).toBe(true);
		expect(retry.body.input.images).toEqual(['https://img/a.jpg']);
	});

	it('surfaces a clear error when the model has no published version', async () => {
		globalThis.fetch = vi.fn(async (url, opts = {}) => {
			const u = String(url);
			if (u.endsWith('/models/firtoz/trellis/predictions')) {
				return new Response(JSON.stringify({ detail: 'The requested resource could not be found.' }), {
					status: 404,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({}), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		});

		const provider = await freshProvider();
		await expect(
			provider.submit({
				mode: 'reconstruct',
				params: { images: ['https://img/a.jpg'] },
				sourceUrl: 'https://img/a.jpg',
			}),
		).rejects.toMatchObject({ code: 'mode_unconfigured' });
	});
});

describe('replicate provider — create-prediction throttle', () => {
	// Replicate 429s prediction CREATION when the account is over its (credit-
	// reduced) rate limit. The window resets in seconds and no prediction was
	// created, so the provider must back off and retry rather than fail the call.
	it('retries a 429 throttle and succeeds once the window resets', async () => {
		let posts = 0;
		globalThis.fetch = vi.fn(async (url) => {
			posts++;
			if (posts === 1) {
				return new Response(
					JSON.stringify({ detail: 'Request was throttled. Your rate limit resets in ~10s.' }),
					// retry-after: 0 keeps the test instant; the backoff math is the same.
					{ status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } },
				);
			}
			return new Response(JSON.stringify({ id: 'pred_throttle_ok', status: 'starting' }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			});
		});

		const provider = await freshProvider();
		const job = await provider.submit({
			mode: 'reconstruct',
			params: { images: ['https://img/a.jpg'] },
			sourceUrl: 'https://img/a.jpg',
		});

		expect(posts).toBe(2); // throttled once, then created
		expect(job.extJobId).toBe('pred_throttle_ok');
	});

	it('surfaces an exhausted throttle as a retryable rate_limited error without leaking billing state', async () => {
		// No Retry-After header → the backoff + the surfaced hint are both parsed
		// from the "resets in ~3s" body phrasing. Fake timers skip the real waits.
		// The raw `detail` names the account credit balance (the production incident):
		// keep it for logs/providerDetail, but never let it become the surfaced message.
		const RAW_DETAIL =
			'Request was throttled. Your rate limit for creating predictions is reduced to 6 requests ' +
			'per minute with a burst of 1 requests while you have less than $5.0 in credit. ' +
			'Your rate limit resets in ~3s.';
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ detail: RAW_DETAIL }), {
					status: 429,
					headers: { 'content-type': 'application/json' },
				}),
			);

			const provider = await freshProvider();
			let caught;
			const pending = provider
				.submit({
					mode: 'reconstruct',
					params: { images: ['https://img/a.jpg'] },
					sourceUrl: 'https://img/a.jpg',
				})
				.catch((e) => {
					caught = e;
					throw e;
				});
			const assertion = expect(pending).rejects.toMatchObject({
				code: 'rate_limited',
				status: 429,
				retryAfter: 3,
				providerDetail: RAW_DETAIL, // retained for server logs
			});
			await vi.runAllTimersAsync(); // advance through the bounded backoff sleeps
			await assertion;
			// The surfaced message is clean — no provider name, credit balance, or raw limits.
			expect(caught.message).toBe('3D generation is briefly busy upstream — please retry in a few seconds.');
			expect(caught.message).not.toMatch(/credit|\$5|throttl|rate limit|replicate/i);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('replicate provider — GLB extraction from status', () => {
	function stubStatus(output) {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ id: 'pred_123', status: 'succeeded', output }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
	}

	it('resolves the GLB from the TRELLIS `model_file` output key', async () => {
		stubStatus({ model_file: 'https://cdn/replicate/output.glb', color_video: null });
		const provider = await freshProvider();
		const res = await provider.status('pred_123');
		expect(res.status).toBe('done');
		expect(res.resultGlbUrl).toBe('https://cdn/replicate/output.glb');
		expect(res.error).toBeUndefined();
	});

	it('reports a clear error when a finished prediction carries no GLB', async () => {
		stubStatus({ color_video: 'https://cdn/replicate/render.mp4' });
		const provider = await freshProvider();
		const res = await provider.status('pred_123');
		expect(res.status).toBe('done');
		expect(res.resultGlbUrl).toBeUndefined();
		expect(res.error).toMatch(/no GLB/i);
	});
});
