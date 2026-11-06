/**
 * redis.js auth-failure fast-fail breaker — unit test.
 *
 * A WRONGPASS / "invalid or missing auth token" response from Upstash is a
 * PERMANENT, config-level failure (a rotated/stale UPSTASH_REDIS_REST_TOKEN), not
 * the transient blip the per-consumer fallbacks were written for. Without a
 * breaker every limiter / cache / usage path keeps issuing doomed commands on
 * every request — a real Upstash round-trip (latency + quota) that fails
 * identically, plus a log line — which is the 24k-warning flood seen in prod
 * (log export 2026-06-28). This pins the breaker: first auth failure opens it,
 * subsequent commands fast-fail with `circuitOpen` and NO network call, and a
 * later success (token rotated) closes it.
 *
 * The @upstash/redis client issues each command as a fetch() to the REST URL, so
 * we stub global fetch to simulate WRONGPASS, then a recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRedis, redisAuthBreakerState, __resetRedisAuthBreaker } from '../api/_lib/redis.js';

const URL = 'https://breaker-test.upstash.io';
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
let saved;

// Minimal stand-in for a fetch Response. The upstash HttpClient reads
// `response.headers.get(...)`, so the headers shim is required. The client has
// auto-pipelining on by default: a batched request body is an array of command
// arrays (`[["GET","k"]]`) and expects an array of result objects back, while a
// single command (`["GET","k"]`) expects one object — so the mock mirrors the
// request shape to stay valid under both paths.
const HEADERS = { get: () => null };

function makeResponse(body, init) {
	let parsed;
	try {
		parsed = JSON.parse(init?.body || 'null');
	} catch {
		parsed = null;
	}
	const isPipeline = Array.isArray(parsed) && Array.isArray(parsed[0]);
	const payload = isPipeline ? parsed.map(() => body) : body;
	return {
		ok: true,
		status: 200,
		headers: HEADERS,
		async json() {
			return payload;
		},
		async text() {
			return JSON.stringify(payload);
		},
	};
}

const WRONGPASS = { error: 'WRONGPASS invalid or missing auth token.' };
const wrongpassResponse = (init) => makeResponse(WRONGPASS, init);
const okResponse = (result, init) => makeResponse({ result }, init);

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.UPSTASH_REDIS_REST_URL = URL;
	process.env.UPSTASH_REDIS_REST_TOKEN = 'stale-token';
	__resetRedisAuthBreaker();
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.restoreAllMocks();
	__resetRedisAuthBreaker();
});

describe('redis auth breaker', () => {
	it('opens on the first WRONGPASS and then fast-fails commands without calling fetch', async () => {
		const fetchMock = vi.fn(async (_url, init) => wrongpassResponse(init));
		globalThis.fetch = fetchMock;
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const r = getRedis();
		expect(r).toBeTruthy();

		// First command hits the network and fails with the auth error.
		await expect(r.get('k')).rejects.toThrow(/WRONGPASS/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(redisAuthBreakerState().open).toBe(true);

		// Subsequent commands short-circuit: no further fetch, rejection tagged circuitOpen.
		for (let i = 0; i < 50; i++) {
			const err = await r.get('k').then(() => null, (e) => e);
			expect(err).toBeTruthy();
			expect(err.circuitOpen).toBe(true);
		}
		expect(fetchMock).toHaveBeenCalledTimes(1); // still just the one real call
	});

	it('self-heals via a half-open trial once the token is valid again', async () => {
		let mode = 'wrongpass';
		const fetchMock = vi.fn(async (_url, init) => (mode === 'wrongpass' ? wrongpassResponse(init) : okResponse('PONG', init)));
		globalThis.fetch = fetchMock;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Shortest cooldown the breaker allows (1s floor) so the trial is admitted quickly.
		process.env.REDIS_AUTH_BREAKER_COOLDOWN_MS = '1000';
		__resetRedisAuthBreaker();

		const r = getRedis();
		await expect(r.get('k')).rejects.toThrow(/WRONGPASS/i);
		expect(redisAuthBreakerState().open).toBe(true);

		// While open, fast-fail (no network).
		await expect(r.get('k')).rejects.toMatchObject({ circuitOpen: true });
		const callsWhileOpen = fetchMock.mock.calls.length;

		// Token rotated; wait out the cooldown so a half-open trial is admitted.
		mode = 'ok';
		await new Promise((res) => setTimeout(res, 1100));

		// The trial command goes through (a real fetch) and succeeds → breaker closes.
		// (We assert recovery, not the returned value — upstash's auto-deserialization
		// mangles the synthetic 'PONG', which is irrelevant to the breaker.)
		await r.get('k');
		expect(fetchMock.mock.calls.length).toBe(callsWhileOpen + 1);
		expect(redisAuthBreakerState().open).toBe(false);

		delete process.env.REDIS_AUTH_BREAKER_COOLDOWN_MS;
	});

	it('does not trip on transient (non-auth) errors', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('The operation was aborted due to timeout');
		});
		globalThis.fetch = fetchMock;

		const r = getRedis();
		await expect(r.get('k')).rejects.toThrow(/timeout/i);
		// Transient error must NOT open the breaker — those are worth retrying, and a
		// closed breaker means the next command still reaches the network (the upstash
		// client adds its own retry layer beneath us, so we don't assert a call count).
		expect(redisAuthBreakerState().open).toBe(false);
		const before = fetchMock.mock.calls.length;
		await expect(r.get('k')).rejects.toThrow(/timeout/i);
		expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
		expect(redisAuthBreakerState().open).toBe(false);
	});
});
