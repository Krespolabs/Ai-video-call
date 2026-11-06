// Tests for the first-party uptime pipeline:
//   api/cron/uptime-check.js — probes targets, stores snapshots + daily
//                              aggregates, alerts on failure and recovery
//   api/status.js            — public aggregation the /status page renders
// All upstreams (fetch, cache, alerts, rate limits) are mocked; the contract
// under test is storage shape, aggregation math, auth, and alert behavior.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cache = new Map();
vi.mock('../../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async (k) => (cache.has(k) ? cache.get(k) : null)),
	cacheSet: vi.fn(async (k, v) => {
		// JSON round-trip like real Redis, so handlers can't rely on references.
		cache.set(k, JSON.parse(JSON.stringify(v)));
	}),
	cacheDel: vi.fn(async (k) => cache.delete(k)),
	cacheBackend: () => 'memory',
}));

const sendOpsAlert = vi.fn();
vi.mock('../../api/_lib/alerts.js', () => ({
	sendOpsAlert: (...args) => sendOpsAlert(...args),
}));

// Internal subsystem health (db/ring/world checks) is covered by its own suite
// (tests/subsystem-health.test.js). Mock it healthy here so this file stays a
// deterministic test of the reachability pipeline: probes, storage shape,
// aggregation math, and target alerting.
vi.mock('../../api/_lib/ops/subsystem-health.js', () => ({
	gatherSubsystemHealth: vi.fn(async () => ({ status: 'ok', degraded: [], subsystems: [] })),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const upstream = { failIds: new Set() };
const realFetch = global.fetch;

const { default: cronHandler, UPTIME_TARGETS } = await import('../../api/cron/uptime-check.js');
const { default: statusHandler } = await import('../../api/status.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function runCron({ secret = 'test-secret' } = {}) {
	const res = makeRes();
	await cronHandler(
		{
			method: 'GET',
			url: '/api/cron/uptime-check',
			headers: secret ? { authorization: `Bearer ${secret}` } : {},
		},
		res,
	);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function runStatus() {
	const res = makeRes();
	await statusHandler({ method: 'GET', url: '/api/status', headers: {} }, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
}

beforeEach(() => {
	cache.clear();
	upstream.failIds.clear();
	sendOpsAlert.mockClear();
	process.env.CRON_SECRET = 'test-secret';
	// A fresh, healthy economy heartbeat so the economy watchdog inside the cron
	// stays quiet — its own alerting (dead heartbeat, engine problems, feed
	// silence) is covered by the watchdog cases, not the reachability ones.
	cache.set('economy:last-tick', { t: Date.now(), fired: 1, failed: 0, engines: [] });
	global.fetch = vi.fn(async (url) => {
		const u = new URL(String(url));
		const target = UPTIME_TARGETS.find((t) => u.pathname + u.search === t.path);
		const fail = target && upstream.failIds.has(target.id);
		return { ok: !fail, status: fail ? 503 : 200 };
	});
	return () => {
		global.fetch = realFetch;
	};
});

describe('api/cron/uptime-check', () => {
	it('rejects a missing or wrong cron secret', async () => {
		expect((await runCron({ secret: 'wrong' })).status).toBe(401);
		expect((await runCron({ secret: null })).status).toBe(401);
		delete process.env.CRON_SECRET;
		expect((await runCron({})).status).toBe(503);
	});

	it('probes every target and stores a snapshot + daily aggregate', async () => {
		const { status, body } = await runCron();
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(Object.keys(body.results).sort()).toEqual(UPTIME_TARGETS.map((t) => t.id).sort());

		const snaps = cache.get('uptime:snapshots');
		expect(snaps).toHaveLength(1);
		const daily = cache.get('uptime:daily');
		expect(daily).toHaveLength(1);
		for (const t of UPTIME_TARGETS) {
			expect(daily[0].targets[t.id]).toMatchObject({ n: 1, up: 1 });
		}
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('alerts on a down target and announces recovery', async () => {
		upstream.failIds.add('api');
		const down = await runCron();
		expect(down.body.ok).toBe(false);
		expect(down.body.down).toBe(1);
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		expect(sendOpsAlert.mock.calls[0][0]).toContain('DOWN');

		sendOpsAlert.mockClear();
		upstream.failIds.clear();
		await runCron();
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		expect(sendOpsAlert.mock.calls[0][0]).toContain('RECOVERED');
	});

	it('caps the snapshot window and accumulates daily counts', async () => {
		await runCron();
		await runCron();
		await runCron();
		expect(cache.get('uptime:snapshots')).toHaveLength(3);
		const daily = cache.get('uptime:daily');
		expect(daily).toHaveLength(1);
		expect(daily[0].targets.site).toMatchObject({ n: 3, up: 3 });
	});
});

describe('api/status', () => {
	it('reports warming-up with no probe data', async () => {
		const { status, body } = await runStatus();
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.monitoring).toBe('warming-up');
		expect(body.services).toHaveLength(UPTIME_TARGETS.length);
		for (const s of body.services) {
			expect(s.operational).toBeNull();
			expect(s.uptime24h).toBeNull();
		}
	});

	it('aggregates uptime and latency from probe history', async () => {
		upstream.failIds.add('explore');
		await runCron();
		upstream.failIds.clear();
		await runCron();

		const { body } = await runStatus();
		expect(body.monitoring).toBe('active');
		const explore = body.services.find((s) => s.id === 'explore');
		expect(explore.operational).toBe(true); // latest probe is green
		expect(explore.uptime24h).toBe(50);
		expect(explore.uptime90d).toBe(50);
		expect(explore.history).toHaveLength(1);
		const site = body.services.find((s) => s.id === 'site');
		expect(site.uptime24h).toBe(100);
		expect(body.ok).toBe(true);
	});

	it('flags the platform not-ok while a service is down', async () => {
		upstream.failIds.add('api');
		await runCron();
		const { body } = await runStatus();
		expect(body.ok).toBe(false);
		expect(body.services.find((s) => s.id === 'api').operational).toBe(false);
	});

	it('is publicly cacheable', async () => {
		const { res } = await runStatus();
		expect(res.headers['cache-control']).toContain('max-age=60');
	});
});
