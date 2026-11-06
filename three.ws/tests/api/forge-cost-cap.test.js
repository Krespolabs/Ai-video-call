/**
 * Global cost circuit breaker for platform-keyed paid 3D generation.
 *
 * Per-user caps (mcp3dGenerate, 30/h) stop ONE caller. They do not stop an
 * influx — or distributed abuse — where many callers each stay under their own
 * cap but collectively drain the shared Replicate/self-host budget. The global
 * ceiling (mcp3dGenerateGlobal, keyed by 'global') is the backstop, mirroring
 * chatHostKeyGlobal / x402PayGlobal.
 *
 * The ceiling is baked into the bucket at module load, so we set it LOW via env
 * BEFORE importing the limiter. Tests run non-prod with no Redis → the limiter
 * uses the per-instance memory fallback, which enforces the cap deterministically.
 */

import { describe, it, expect, afterAll } from 'vitest';

const PREV = process.env.FORGE_PAID_GLOBAL_HOURLY;
process.env.FORGE_PAID_GLOBAL_HOURLY = '3';

const { limits } = await import('../../api/_lib/rate-limit.js');

describe('forge paid-generation global cost circuit breaker', () => {
	afterAll(() => {
		if (PREV === undefined) delete process.env.FORGE_PAID_GLOBAL_HOURLY;
		else process.env.FORGE_PAID_GLOBAL_HOURLY = PREV;
	});

	it('exposes a global paid-generation limiter keyed by the whole platform', () => {
		expect(typeof limits.mcp3dGenerateGlobal).toBe('function');
	});

	it('allows up to the configured ceiling, then opens the circuit', async () => {
		const results = [];
		for (let i = 0; i < 5; i++) results.push(await limits.mcp3dGenerateGlobal());

		const allowed = results.filter((r) => r.success).length;
		const denied = results.filter((r) => !r.success).length;

		// FORGE_PAID_GLOBAL_HOURLY=3 → exactly 3 allowed, the rest denied.
		expect(allowed).toBe(3);
		expect(denied).toBe(2);

		// A denied result carries a future reset so the client can show retry-after.
		const last = results[results.length - 1];
		expect(last.success).toBe(false);
		expect(last.reset).toBeGreaterThan(Date.now());
	});
});
