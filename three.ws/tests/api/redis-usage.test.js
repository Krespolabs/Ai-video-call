// Redis quota-burn visibility (api/_lib/redis-usage.js).
//
// The free Upstash plan ceils at 500k commands/month; exceeding it fails every
// critical limiter closed and 503s the whole paid surface (June 2026). These
// tests pin the burn classifier and the ops-alert threshold so a runaway burn
// rate can never page late — or fabricate a number when usage is unreadable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	evaluateRedisBurn,
	redisBurnAlert,
	fetchRedisDailyCommands,
	REDIS_MONTHLY_BUDGET,
} from '../../api/_lib/redis-usage.js';

describe('evaluateRedisBurn — classification', () => {
	it('reports ok well under the daily budget', () => {
		const burn = evaluateRedisBurn(5_000); // ~30% of the daily budget
		expect(burn.status).toBe('ok');
		expect(burn.monthlyBudget).toBe(REDIS_MONTHLY_BUDGET);
		expect(burn.projectedMonthly).toBe(150_000);
		expect(burn.percentUsed).toBeCloseTo(30, 0);
	});

	it('warns above 70% of the daily budget', () => {
		const burn = evaluateRedisBurn(13_000); // ~78% → projects ~390k
		expect(burn.status).toBe('warning');
		expect(burn.projectedMonthly).toBe(390_000);
	});

	it('goes critical above 90% of the daily budget', () => {
		const burn = evaluateRedisBurn(16_000); // ~96% → projects 480k
		expect(burn.status).toBe('critical');
		expect(burn.projectedMonthly).toBe(480_000);
	});

	it('reports unknown (never a fabricated number) when usage is unreadable', () => {
		for (const v of [null, undefined, NaN, -1]) {
			const burn = evaluateRedisBurn(v);
			expect(burn.status).toBe('unknown');
			expect(burn.dailyCommands).toBeNull();
			expect(burn.projectedMonthly).toBeNull();
			expect(burn.percentUsed).toBeNull();
		}
	});
});

describe('redisBurnAlert — ops paging thresholds', () => {
	it('does not alert below the 400k projection', () => {
		expect(redisBurnAlert(evaluateRedisBurn(10_000))).toBeNull(); // projects 300k
	});

	it('fires a warning once the projection crosses 400k', () => {
		const alert = redisBurnAlert(evaluateRedisBurn(14_000)); // projects 420k
		expect(alert).not.toBeNull();
		expect(alert.level).toBe('warning');
		expect(alert.message).toMatch(/420k\/500k/);
		expect(alert.message).toMatch(/upgrade/i);
	});

	it('escalates to critical once the projection crosses 450k', () => {
		const alert = redisBurnAlert(evaluateRedisBurn(16_000)); // projects 480k
		expect(alert).not.toBeNull();
		expect(alert.level).toBe('critical');
		expect(alert.message).toMatch(/480k\/500k/);
		expect(alert.title).toMatch(/outage/i);
	});

	it('never alerts on unknown usage', () => {
		expect(redisBurnAlert(evaluateRedisBurn(null))).toBeNull();
	});
});

describe('fetchRedisDailyCommands — real source, honest fallback', () => {
	const ENV = [
		'UPSTASH_EMAIL',
		'UPSTASH_MANAGEMENT_API_KEY',
		'UPSTASH_API_KEY',
		'UPSTASH_REDIS_STORE_ID',
		'UPSTASH_REDIS_REST_URL',
		'UPSTASH_REDIS_REST_TOKEN',
	];
	const saved = {};
	let savedFetch;
	beforeEach(() => {
		for (const v of ENV) {
			saved[v] = process.env[v];
			delete process.env[v];
		}
		savedFetch = global.fetch;
	});
	afterEach(() => {
		for (const v of ENV) {
			if (saved[v] === undefined) delete process.env[v];
			else process.env[v] = saved[v];
		}
		global.fetch = savedFetch;
	});

	it('returns null without any credentials (no fetch, no fabrication)', async () => {
		global.fetch = vi.fn();
		expect(await fetchRedisDailyCommands()).toBeNull();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('reads the daily count from the Upstash Management API', async () => {
		process.env.UPSTASH_EMAIL = 'ops@three.ws';
		process.env.UPSTASH_MANAGEMENT_API_KEY = 'mgmt-key';
		process.env.UPSTASH_REDIS_STORE_ID = 'store_test';
		global.fetch = vi.fn(async (url) => {
			expect(String(url)).toContain('api.upstash.com/v2/redis/stats/store_test');
			return new Response(JSON.stringify({ dailyrequests: [{ x: 1, y: 12_345 }] }), { status: 200 });
		});
		expect(await fetchRedisDailyCommands()).toBe(12_345);
	});

	it('falls back to the REST /stats/daily summary when management creds are absent', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://probe.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'rest-token';
		global.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe('https://probe.upstash.io/stats/daily');
			return new Response(JSON.stringify({ totalCommands: 9_876 }), { status: 200 });
		});
		expect(await fetchRedisDailyCommands()).toBe(9_876);
	});

	it('returns null (not a guess) when the stats endpoint errors', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://probe.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'rest-token';
		global.fetch = vi.fn(async () => new Response('nope', { status: 500 }));
		expect(await fetchRedisDailyCommands()).toBeNull();
	});
});
