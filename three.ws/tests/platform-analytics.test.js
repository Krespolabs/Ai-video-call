// /api/platform/analytics data layer: window math, zero-filled daily series,
// per-metric `method` strings, and the failure contract (a failing source is
// `null` plus a named error, never a zero and never a thrown 500).
//
// Sources are injected, so these tests exercise the real aggregation and shaping
// code without a database. The SQL itself is exercised against production data
// by `curl /api/platform/analytics` (see docs/api-reference.md).

import { describe, it, expect, vi } from 'vitest';
import {
	readPlatformAnalytics,
	resolveWindow,
	windowStartDay,
	dayRange,
	METRICS,
} from '../api/_lib/platform-analytics.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');

function okSources(overrides = {}) {
	return {
		agents: async () => ({
			total: { agents: 100, agents_with_wallet: 40 },
			daily: [
				{ day: '2026-09-29', agents: 3, agents_with_wallet: 1 },
				{ day: '2026-09-30', agents: 2, agents_with_wallet: 2 },
			],
		}),
		launches: async () => ({ total: { coins_launched: 5 }, daily: [{ day: '2026-09-15', coins_launched: 1 }] }),
		forge: async () => ({ total: { models_generated: 9 }, daily: [] }),
		llm: async () => ({ total: { llm_tokens: 1000 }, daily: [{ day: '2026-09-30', llm_tokens: 250 }] }),
		x402: async () => ({
			total: { x402_settlements: 7, x402_volume_usd: 0.1 + 0.2 },
			daily: [{ day: '2026-09-30', x402_settlements: 7, x402_volume_usd: 0.1 + 0.2 }],
		}),
		marketplace: async () => ({
			total: { marketplace_sales: 0, marketplace_volume_three: 0, marketplace_volume_usd: 0 },
			daily: [],
		}),
		hires: async () => ({ total: { hire_volume_usd: 0 }, daily: [] }),
		creatorFees: async () => ({ total: { creator_fees: 5.5 }, daily: [{ day: '2026-09-28', creator_fees: 0.25 }] }),
		...overrides,
	};
}

describe('window helpers', () => {
	it('accepts only the documented windows and defaults to 30d', () => {
		expect(resolveWindow('90d')).toBe('90d');
		expect(resolveWindow('ALL')).toBe('all');
		expect(resolveWindow('7d')).toBe('30d');
		expect(resolveWindow(undefined)).toBe('30d');
		expect(resolveWindow(['all'])).toBe('all');
	});

	it('counts today as day one of a bounded window', () => {
		expect(windowStartDay('30d', NOW)).toBe('2026-09-01');
		expect(windowStartDay('90d', NOW)).toBe('2026-07-03');
		expect(windowStartDay('all', NOW)).toBeNull();
		expect(dayRange('2026-09-01', NOW)).toHaveLength(30);
	});
});

describe('readPlatformAnalytics', () => {
	it('returns every metric with a method, totals and a zero-filled daily series', async () => {
		const body = await readPlatformAnalytics({ window: '30d', now: NOW, sources: okSources() });
		expect(body.window).toBe('30d');
		expect(body.window_days).toBe(30);
		expect(body.from).toBe('2026-09-01');
		expect(body.to).toBe('2026-09-30');
		expect(body.errors).toEqual([]);
		expect(Object.keys(body.metrics)).toEqual(METRICS.map((m) => m.key));
		for (const m of Object.values(body.metrics)) expect(typeof m.method).toBe('string');

		const agents = body.metrics.agents;
		expect(agents.total).toBe(100);
		expect(agents.window_total).toBe(5);
		expect(agents.daily).toHaveLength(30);
		expect(agents.daily.at(-1)).toEqual({ day: '2026-09-30', value: 2 });
		expect(agents.daily[0]).toEqual({ day: '2026-09-01', value: 0 });

		// Float drift from summing decimal amounts is tidied.
		expect(body.metrics.x402_volume_usd.total).toBe(0.3);
	});

	it('reports creator fees in SOL from the earnings snapshot', async () => {
		const body = await readPlatformAnalytics({ window: '30d', now: NOW, sources: okSources() });
		expect(body.metrics.creator_fees).toMatchObject({ available: true, unit: 'sol', total: 5.5, window_total: 0.25 });
		expect(body.metrics.creator_fees.method).toMatch(/custodial wallet/);
	});

	it('turns a failing source into null metrics plus named errors, never zero', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const body = await readPlatformAnalytics({
			window: '30d',
			now: NOW,
			sources: okSources({ x402: async () => { throw new Error('connection reset'); } }),
		});
		warn.mockRestore();
		expect(body.metrics.x402_settlements).toMatchObject({ available: false, total: null, window_total: null, daily: null });
		expect(body.metrics.x402_volume_usd.total).toBeNull();
		expect(body.errors.map((e) => e.metric)).toEqual(['x402_settlements', 'x402_volume_usd']);
		expect(body.errors[0]).toMatchObject({ source: 'x402', error: 'query_failed' });
		// Every other metric is still served.
		expect(body.metrics.agents.total).toBe(100);
	});

	it('starts the all-time window on the first day any source recorded activity', async () => {
		const body = await readPlatformAnalytics({ window: 'all', now: NOW, sources: okSources() });
		expect(body.from).toBe('2026-09-15');
		expect(body.metrics.coins_launched.daily[0]).toEqual({ day: '2026-09-15', value: 1 });
		expect(body.metrics.coins_launched.window_total).toBe(1);
	});
});
