// Free 3D Studio (api/mcp-studio.js) rate-limiter disposition under a Redis
// outage. The June-2026 Upstash over-quota incident took the whole free studio
// down: its generation limiters were marked `critical` and so FAILED CLOSED when
// every Redis command started rejecting with "max requests limit exceeded",
// denying a zero-cost feature for no spend saved.
//
// Contract proven here (with a mocked Upstash whose every command rejects, in a
// simulated production env):
//   - the studio's free-lane generation caps FAIL OPEN (success: true) — a Redis
//     blip must never dead-end a free generation, mirroring mcp3dGenerateFree;
//   - a genuinely cost-bearing bucket (mcp3dGenerate — the paid MCP lane) still
//     FAILS CLOSED (success: false), so the harness really is simulating an
//     outage and the money-protecting posture is intact.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A stand-in Upstash client whose EVERY method rejects, reproducing the
// over-quota state where the REST endpoint 400s on every command. A Proxy covers
// whatever command @upstash/ratelimit reaches for (eval/scripts/sliding-window)
// without pinning the test to its internals.
vi.mock('@upstash/redis', () => ({
	Redis: class {
		constructor() {
			return new Proxy(this, {
				get() {
					return () => Promise.reject(new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000'));
				},
			});
		}
	},
}));

let limits;
const prevNodeEnv = process.env.NODE_ENV;
const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;

beforeAll(async () => {
	// Production + a configured (but failing) Redis is exactly the incident shape:
	// redis is present, so buckets take the resilientLimiter path, and IS_PRODUCTION
	// makes `critical` buckets fail closed. A non-critical bucket fails open here.
	process.env.NODE_ENV = 'production';
	process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.invalid';
	process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
	vi.resetModules();
	({ limits } = await import('../api/_lib/rate-limit.js'));
});

afterAll(() => {
	process.env.NODE_ENV = prevNodeEnv;
	if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
	else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
	if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
	else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
	vi.resetModules();
});

describe('free studio limiters under a Redis outage', () => {
	it('studioGenBurst fails OPEN (free lane must not dead-end)', async () => {
		const r = await limits.studioGenBurst('203.0.113.7');
		expect(r.success).toBe(true);
	});

	it('studioGenHourly fails OPEN', async () => {
		const r = await limits.studioGenHourly('203.0.113.7');
		expect(r.success).toBe(true);
	});

	it('studioGenerateGlobal fails OPEN', async () => {
		const r = await limits.studioGenerateGlobal();
		expect(r.success).toBe(true);
	});

	it('studioIp (transport) fails OPEN', async () => {
		const r = await limits.studioIp('203.0.113.7');
		expect(r.success).toBe(true);
	});

	it('the paid MCP lane (mcp3dGenerate) still FAILS CLOSED — spend stays protected', async () => {
		const r = await limits.mcp3dGenerate('some-principal');
		expect(r.success).toBe(false);
	});
});
