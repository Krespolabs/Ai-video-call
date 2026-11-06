// Sketch→3D (TripoSG) — registry + provider routing contract.
//
// Covers the path added for sketch-conditioned generation:
//   • forge-tiers registers a sketch path with TripoSG as its self-host
//     default, configured only when GCP_TRIPOSG_URL (+ shared key) is set,
//     and never disturbs the image/geometry defaults.
//   • The GCP provider's `sketch` mode posts the drawing + prompt to the
//     TripoSG worker's /infer in scribble mode, carries the tier's poly
//     budget, and resolves the finished GLB from result_gcs_url on poll.
//
// We stub global fetch to capture the worker submit body and to model the
// worker's task responses; no network, no mocked product data.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['GCP_TRIPOSG_URL', 'GCP_RECONSTRUCTION_KEY', 'NVIDIA_API_KEY'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const WORKER_URL = 'https://model-triposg-test.a.run.app';

beforeEach(() => {
	process.env.GCP_TRIPOSG_URL = WORKER_URL;
	process.env.GCP_RECONSTRUCTION_KEY = 'test-shared-key';
	delete process.env.NVIDIA_API_KEY;
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
});

describe('forge-tiers — sketch path registration', () => {
	it('registers sketch as a first-class path with TripoSG as its default', async () => {
		const { PATHS, BACKENDS, DEFAULT_BACKEND_FOR_PATH, resolveBackendId } = await import(
			'../../api/_lib/forge-tiers.js'
		);
		expect(PATHS).toContain('sketch');
		expect(DEFAULT_BACKEND_FOR_PATH.sketch).toBe('triposg');
		expect(resolveBackendId({ path: 'sketch', tier: 'standard' })).toBe('triposg');

		const b = BACKENDS.triposg;
		expect(b.provider).toBe('gcp');
		expect(b.byok).toBe(false);
		expect(b.paths).toEqual(['sketch']);
		expect(b.requiresEnv).toEqual(['GCP_TRIPOSG_URL', 'GCP_RECONSTRUCTION_KEY']);
		// The worker decimates to the tier's budget — poly control is real here.
		expect(b.polyControl).toBe(true);
	});

	it('is configured only when the worker URL + shared key are present', async () => {
		const { backendIsConfigured } = await import('../../api/_lib/forge-tiers.js');
		expect(backendIsConfigured('triposg')).toBe(true);
		delete process.env.GCP_TRIPOSG_URL;
		expect(backendIsConfigured('triposg')).toBe(false);
	});

	it('never serves the image or geometry paths, even when explicitly named', async () => {
		const { resolveBackendId } = await import('../../api/_lib/forge-tiers.js');
		// An explicit backend is honored only when it serves the requested path —
		// a photo/text submission naming triposg falls back to that path's default.
		expect(resolveBackendId({ path: 'image', tier: 'standard', backend: 'triposg' })).toBe('trellis');
		expect(resolveBackendId({ path: 'geometry', tier: 'standard', backend: 'triposg' })).toBe('meshy');
		// And the standing defaults are untouched.
		expect(resolveBackendId({ path: 'image', tier: 'standard' })).toBe('trellis');
		expect(resolveBackendId({ path: 'geometry', tier: 'draft' })).toBe('meshy');
	});

	it('surfaces the sketch lane in the public catalog with per-tier estimates', async () => {
		const { buildCatalog } = await import('../../api/_lib/forge-tiers.js');
		const cat = buildCatalog();
		expect(cat.paths).toContain('sketch');
		expect(cat.default_backend.sketch).toBe('triposg');
		expect(cat.default_backend_for_tier.standard.sketch).toBe('triposg');

		const lane = cat.backends.find((b) => b.id === 'triposg');
		expect(lane).toBeTruthy();
		expect(lane.configured).toBe(true);
		expect(lane.byok).toBeNull();
		expect(lane.user_images).toBe(true);
		const est = lane.estimates.sketch.find((e) => e.tier === 'standard');
		expect(est.eta_seconds).toBeGreaterThan(0);
		expect(est.credits).toBeNull(); // self-host — bills GPU time, not credits
	});
});

describe('gcp provider — sketch mode routing', () => {
	async function freshProvider() {
		const mod = await import('../../api/_providers/gcp.js?t=' + Math.random());
		return mod.createRegenProvider();
	}

	it('supports the sketch mode only when GCP_TRIPOSG_URL is set', async () => {
		let provider = await freshProvider();
		expect(provider.supportsMode('sketch')).toBe(true);
		delete process.env.GCP_TRIPOSG_URL;
		provider = await freshProvider();
		expect(provider.supportsMode('sketch')).toBe(false);
	});

	it('posts the drawing + prompt to /infer in scribble mode with the poly budget', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			calls.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers });
			return new Response(JSON.stringify({ task_id: 'task-abc', status: 'queued' }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			});
		});

		const provider = await freshProvider();
		const job = await provider.submit({
			mode: 'sketch',
			sourceUrl: 'https://cdn.example.com/sketch.png',
			params: { prompt: 'a cartoon rocket with two tail fins', target_polycount: 30_000 },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${WORKER_URL}/infer`);
		expect(calls[0].headers.authorization).toBe('Bearer test-shared-key');
		expect(calls[0].body).toEqual({
			images: ['https://cdn.example.com/sketch.png'],
			prompt: 'a cartoon rocket with two tail fins',
			mode: 'scribble',
			target_polycount: 30_000,
		});
		expect(job.extJobId).toBeTruthy();
		expect(job.backend).toBe('gcp');
	});

	it('resolves the finished mesh from result_gcs_url on poll', async () => {
		// Submit first so the job envelope packs the sketch mode + worker URL.
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ task_id: 'task-abc', status: 'queued' }), { status: 202 }),
		);
		const provider = await freshProvider();
		const job = await provider.submit({
			mode: 'sketch',
			sourceUrl: 'https://cdn.example.com/sketch.png',
			params: { prompt: 'a glazed ceramic teapot' },
		});

		const glb = 'https://storage.googleapis.com/bucket/raw-meshes/triposg/task-abc.glb';
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe(`${WORKER_URL}/tasks/task-abc`);
			return new Response(JSON.stringify({ task_id: 'task-abc', status: 'done', result_gcs_url: glb }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const status = await provider.status(job.extJobId);
		expect(status.status).toBe('done');
		expect(status.resultGlbUrl).toBe(glb);
	});

	it('reports a designed failure when the worker errors the task', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ task_id: 'task-abc', status: 'queued' }), { status: 202 }),
		);
		const provider = await freshProvider();
		const job = await provider.submit({
			mode: 'sketch',
			sourceUrl: 'https://cdn.example.com/sketch.png',
			params: { prompt: 'a vintage film camera' },
		});

		globalThis.fetch = vi.fn(async () =>
			new Response(
				JSON.stringify({ task_id: 'task-abc', status: 'failed', error: 'inference failed' }),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		);
		const status = await provider.status(job.extJobId);
		expect(status.status).toBe('failed');
		expect(status.error).toBe('inference failed');
	});
});

describe('gcp provider: triposg photo mode (the last-resort failover rung)', () => {
	async function freshProvider() {
		const mod = await import('../../api/_providers/gcp.js?t=' + Math.random());
		return mod.createRegenProvider();
	}

	it('posts the photo to the same worker in image mode, with no prompt', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			calls.push({ url: String(url), body: JSON.parse(opts.body) });
			return new Response(JSON.stringify({ task_id: 'task-photo', status: 'queued' }), { status: 202 });
		});

		const provider = await freshProvider();
		expect(provider.supportsMode('triposg')).toBe(true);
		await provider.submit({
			mode: 'triposg',
			sourceUrl: 'https://cdn.example.com/chair.png',
			params: { target_polycount: 30_000 },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${WORKER_URL}/infer`);
		expect(calls[0].body).toEqual({
			images: ['https://cdn.example.com/chair.png'],
			mode: 'image',
			target_polycount: 30_000,
		});
	});

	it('polls the TripoSG worker for the result', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ task_id: 'task-photo', status: 'queued' }), { status: 202 }),
		);
		const provider = await freshProvider();
		const job = await provider.submit({ mode: 'triposg', sourceUrl: 'https://cdn.example.com/chair.png' });

		const glb = 'https://storage.googleapis.com/bucket/raw-meshes/triposg/task-photo.glb';
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe(`${WORKER_URL}/tasks/task-photo`);
			return new Response(JSON.stringify({ task_id: 'task-photo', status: 'done', result_gcs_url: glb }), {
				status: 200,
			});
		});
		const status = await provider.status(job.extJobId);
		expect(status.status).toBe('done');
		expect(status.resultGlbUrl).toBe(glb);
	});

	it('is unsupported when the TripoSG worker is not configured', async () => {
		delete process.env.GCP_TRIPOSG_URL;
		const provider = await freshProvider();
		expect(provider.supportsMode('triposg')).toBe(false);
	});
});
