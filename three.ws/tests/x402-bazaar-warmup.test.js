import { describe, it, expect } from 'vitest';

import {
	WARMUP_CATEGORIES,
	isLivePricedService,
	serviceKey,
	catalogHash,
	extractServices,
	run,
} from '../api/_lib/x402/pipelines/bazaar-warmup.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

const svc = (over = {}) => ({
	resource: 'https://api.example.com/weather',
	price_atomic: 1000,
	networks: ['eip155:8453'],
	...over,
});

describe('bazaar warmup — service validation (live + priced)', () => {
	it('accepts a service with a resource, price, and network', () => {
		expect(isLivePricedService(svc())).toBe(true);
	});

	it('accepts a price label when atomic price is absent', () => {
		expect(isLivePricedService(svc({ price_atomic: undefined, price: '$0.01' }))).toBe(true);
	});

	it('rejects a listing with no resource URL', () => {
		expect(isLivePricedService(svc({ resource: '' }))).toBe(false);
		expect(isLivePricedService(svc({ resource: undefined }))).toBe(false);
	});

	it('rejects a listing with no price', () => {
		expect(isLivePricedService(svc({ price_atomic: undefined, price: undefined }))).toBe(false);
	});

	it('rejects a listing with no network', () => {
		expect(isLivePricedService(svc({ networks: [] }))).toBe(false);
		expect(isLivePricedService(svc({ networks: undefined }))).toBe(false);
	});

	it('rejects null/garbage', () => {
		expect(isLivePricedService(null)).toBe(false);
		expect(isLivePricedService({})).toBe(false);
	});
});

describe('bazaar warmup — drift detection', () => {
	it('keys a service by resource, plus tool name for MCP tools', () => {
		expect(serviceKey(svc())).toBe('https://api.example.com/weather');
		expect(serviceKey(svc({ tool_name: 'forecast' }))).toBe('https://api.example.com/weather#forecast');
	});

	it('hash is stable regardless of service order', () => {
		const a = catalogHash([svc({ resource: 'a' }), svc({ resource: 'b' })]);
		const b = catalogHash([svc({ resource: 'b' }), svc({ resource: 'a' })]);
		expect(a).toBe(b);
	});

	it('hash changes when a service is added or removed', () => {
		const before = catalogHash([svc({ resource: 'a' })]);
		const after = catalogHash([svc({ resource: 'a' }), svc({ resource: 'b' })]);
		expect(before).not.toBe(after);
	});

	it('hash changes on a reprice (so a reprice registers as drift)', () => {
		const before = catalogHash([svc({ resource: 'a', price_atomic: 1000 })]);
		const after = catalogHash([svc({ resource: 'a', price_atomic: 2000 })]);
		expect(before).not.toBe(after);
	});
});

describe('bazaar warmup — JSON-RPC response parsing', () => {
	it('extracts services from a tools/call structuredContent body', () => {
		const body = { result: { structuredContent: { services: [svc(), svc()], sources: ['x402'], errors: [] } } };
		const out = extractServices(body);
		expect(out.services).toHaveLength(2);
		expect(out.hasResult).toBe(true);
		expect(out.sources).toEqual(['x402']);
	});

	it('returns an empty catalog (not throw) on a malformed/error body', () => {
		expect(extractServices(null).services).toEqual([]);
		expect(extractServices({ error: { code: -32000 } }).services).toEqual([]);
		expect(extractServices({ result: {} }).hasResult).toBe(true);
	});
});

describe('bazaar warmup — registry wiring', () => {
	it('sweeps exactly 15 categories', () => {
		expect(WARMUP_CATEGORIES).toHaveLength(15);
		expect(new Set(WARMUP_CATEGORIES).size).toBe(15); // no duplicates
	});

	it('is registered as an enabled, daily, run()-style discovery entry', () => {
		const entry = getFullRegistry().find((e) => e.id === 'bazaar-discovery-warmup');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('discovery');
		expect(entry.cooldown_s).toBe(86400);
		expect(typeof entry.run).toBe('function');
		expect(entry.path).toBe('/api/mcp-bazaar');
	});
});

describe('bazaar warmup — graceful degradation', () => {
	it('never throws when the DB/wallet are unconfigured; returns a skipped outcome', async () => {
		const out = await run({ runId: '00000000-0000-0000-0000-000000000008' });
		expect(out).toMatchObject({ success: false, skipped: true });
		expect(out.amountAtomic).toBe(0);
		expect(typeof out.errorMsg).toBe('string');
	});
});
