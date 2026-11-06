import { describe, it, expect } from 'vitest';

import {
	CATALOG_TYPES,
	catalogHash,
	diffCatalog,
	BAZAAR_CATALOG_REFRESH,
	run,
} from '../api/_lib/x402/pipelines/bazaar-catalog-refresh.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

const mapOf = (...svcs) => new Map(svcs.map((s) => [s.key, s]));
const svc = (over = {}) => ({
	key: 'https://api.example.com/weather',
	resource: 'https://api.example.com/weather',
	tool_name: null,
	name: 'Weather',
	price_atomic: 1000,
	networks: ['eip155:8453'],
	...over,
});

describe('bazaar catalog refresh — catalog hash', () => {
	it('is stable regardless of service order', () => {
		const a = catalogHash([svc({ key: 'a' }), svc({ key: 'b' })]);
		const b = catalogHash([svc({ key: 'b' }), svc({ key: 'a' })]);
		expect(a).toBe(b);
	});

	it('changes when a service is added or removed', () => {
		const before = catalogHash([svc({ key: 'a' })]);
		const after = catalogHash([svc({ key: 'a' }), svc({ key: 'b' })]);
		expect(before).not.toBe(after);
	});

	it('changes on a reprice', () => {
		const before = catalogHash([svc({ key: 'a', price_atomic: 1000 })]);
		const after = catalogHash([svc({ key: 'a', price_atomic: 2000 })]);
		expect(before).not.toBe(after);
	});
});

describe('bazaar catalog refresh — day-over-day diff', () => {
	it('detects added services (opportunity alerts)', () => {
		const prev = mapOf(svc({ key: 'a', resource: 'a' }));
		const today = mapOf(svc({ key: 'a', resource: 'a' }), svc({ key: 'b', resource: 'b' }));
		const { added, removed, repriced } = diffCatalog(prev, today);
		expect(added.map((s) => s.key)).toEqual(['b']);
		expect(removed).toHaveLength(0);
		expect(repriced).toHaveLength(0);
	});

	it('detects removed services (dependency alerts)', () => {
		const prev = mapOf(svc({ key: 'a', resource: 'a' }), svc({ key: 'b', resource: 'b' }));
		const today = mapOf(svc({ key: 'a', resource: 'a' }));
		const { added, removed } = diffCatalog(prev, today);
		expect(removed.map((s) => s.key)).toEqual(['b']);
		expect(added).toHaveLength(0);
	});

	it('detects price changes', () => {
		const prev = mapOf(svc({ key: 'a', resource: 'a', price_atomic: 1000 }));
		const today = mapOf(svc({ key: 'a', resource: 'a', price_atomic: 2500 }));
		const { repriced } = diffCatalog(prev, today);
		expect(repriced).toEqual([
			{ key: 'a', resource: 'a', old_price_atomic: 1000, new_price_atomic: 2500 },
		]);
	});

	it('reports no change when the catalog is identical', () => {
		const prev = mapOf(svc({ key: 'a', resource: 'a' }), svc({ key: 'b', resource: 'b' }));
		const today = mapOf(svc({ key: 'a', resource: 'a' }), svc({ key: 'b', resource: 'b' }));
		const { added, removed, repriced } = diffCatalog(prev, today);
		expect(added).toHaveLength(0);
		expect(removed).toHaveLength(0);
		expect(repriced).toHaveLength(0);
	});

	it('treats null vs a concrete price as a reprice', () => {
		const prev = mapOf(svc({ key: 'a', resource: 'a', price_atomic: null }));
		const today = mapOf(svc({ key: 'a', resource: 'a', price_atomic: 1000 }));
		expect(diffCatalog(prev, today).repriced).toHaveLength(1);
	});
});

describe('bazaar catalog refresh — registry wiring', () => {
	it('censuses both service kinds (http + mcp)', () => {
		expect(CATALOG_TYPES).toEqual(['http', 'mcp']);
	});

	it('is registered as an enabled, daily, run()-style discovery entry', () => {
		const entry = getFullRegistry().find((e) => e.id === 'bazaar-catalog-refresh');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('discovery');
		expect(entry.cooldown_s).toBe(86400);
		expect(entry.price_atomic).toBe(1000);
		expect(entry.path).toBe('/api/mcp-bazaar');
		expect(typeof entry.run).toBe('function');
	});

	it('exposes its constants (endpoint, price, cooldown)', () => {
		expect(BAZAAR_CATALOG_REFRESH.endpoint).toBe('/api/mcp-bazaar');
		expect(BAZAAR_CATALOG_REFRESH.priceAtomic).toBe(1000);
		expect(BAZAAR_CATALOG_REFRESH.cooldownSeconds).toBe(86400);
		expect(BAZAAR_CATALOG_REFRESH.enrichMax).toBeGreaterThan(0);
	});
});

describe('bazaar catalog refresh — graceful degradation', () => {
	it('never throws when the DB/wallet are unconfigured; returns a skipped outcome', async () => {
		const out = await run({ runId: '00000000-0000-0000-0000-000000000009' });
		expect(out).toMatchObject({ success: false, skipped: true });
		expect(out.amountAtomic).toBe(0);
		expect(typeof out.errorMsg).toBe('string');
	});
});
