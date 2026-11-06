// crypto_data + token_snapshot — MCP tools wrapping the /api/v1/x aggregator
// (api/_mcp/tools/crypto-data.js), registered in api/_mcp/catalog.js.
//
// Verifies: both tools are in the discovery catalog with real input schemas;
// crypto_data validates the provider/endpoint pair against the live registry
// and errors helpfully (listing valid pairs) on an unknown one; a free-tier
// endpoint runs through executeUpstream and returns structuredContent; a
// quota-exhausted or payment-only endpoint throws a -32402 JSON-RPC error
// naming the real REST URL + price (never a fake MCP-only payment flow);
// token_snapshot merges partial provider availability (skip/fail) without
// throwing. The rate limiter and aggregator engine are mocked at their module
// boundary — real registry lookups (ENDPOINT_INDEX) run unmocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeUpstreamMock = vi.fn();
vi.mock('../../api/_lib/aggregator.js', () => ({
	executeUpstream: (...a) => executeUpstreamMock(...a),
	resolveUpstreamKey: () => ({ key: null, source: 'platform' }),
}));

let minOk = true;
let dayOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1FreeMin: async (_key, limit) =>
			minOk
				? { success: true, limit, remaining: limit - 1, reset: Date.now() + 60_000 }
				: { success: false, limit, remaining: 0, reset: Date.now() + 60_000 },
		apiV1FreeDay: async (_key, limit) =>
			dayOk
				? { success: true, limit, remaining: limit - 1, reset: Date.now() + 86_400_000 }
				: { success: false, limit, remaining: 0, reset: Date.now() + 86_400_000 },
	},
	clientIp: () => '203.0.113.7',
}));

beforeEach(() => {
	executeUpstreamMock.mockReset();
	minOk = true;
	dayOk = true;
});

// ── Catalog discovery — both tools registered with real schemas ───────────────
describe('api/_mcp/catalog — crypto_data + token_snapshot', () => {
	it('lists both tools with input schemas and live-registry-generated descriptions', async () => {
		const { TOOL_CATALOG, TOOLS } = await import('../../api/_mcp/catalog.js');

		const cryptoData = TOOL_CATALOG.find((t) => t.name === 'crypto_data');
		expect(cryptoData).toBeTruthy();
		expect(cryptoData.inputSchema.required).toEqual(['provider', 'endpoint']);
		// Generated from the live registry, not hand-enumerated — must mention a
		// real registered provider/endpoint pair rather than a static string.
		expect(cryptoData.description).toMatch(/dexscreener\/token|coingecko\/price|jupiter\/price/);

		const tokenSnapshot = TOOL_CATALOG.find((t) => t.name === 'token_snapshot');
		expect(tokenSnapshot).toBeTruthy();
		expect(tokenSnapshot.inputSchema.required).toEqual(['mint']);

		expect(TOOLS.crypto_data).toBeTruthy();
		expect(TOOLS.token_snapshot).toBeTruthy();
		expect(typeof TOOLS.crypto_data.handler).toBe('function');
		expect(typeof TOOLS.token_snapshot.handler).toBe('function');
	});
});

// ── crypto_data ─────────────────────────────────────────────────────────────
describe('crypto_data tool', () => {
	it('errors helpfully on an unknown provider/endpoint pair, listing valid ones', async () => {
		const { toolDefs } = await import('../../api/_mcp/tools/crypto-data.js');
		const tool = toolDefs.find((t) => t.name === 'crypto_data');
		const result = await tool.handler({ provider: 'nope', endpoint: 'nothing' }, {}, null);
		expect(result.isError).toBe(true);
		expect(result.structuredContent.error).toBe('unknown_pair');
		expect(Array.isArray(result.structuredContent.valid_pairs)).toBe(true);
		expect(result.structuredContent.valid_pairs.length).toBeGreaterThan(0);
		expect(executeUpstreamMock).not.toHaveBeenCalled();
	});

	it('runs a free-tier endpoint through executeUpstream and returns structuredContent', async () => {
		const { ENDPOINT_INDEX } = await import('../../api/v1/_providers.js');
		const [pairKey] = [...ENDPOINT_INDEX.keys()].filter((k) => {
			const { endpoint } = ENDPOINT_INDEX.get(k);
			return Boolean(endpoint.free);
		});
		expect(pairKey).toBeTruthy(); // sanity: at least one free endpoint is registered
		const [providerId, endpointId] = pairKey.split('/');

		executeUpstreamMock.mockResolvedValue({ fixture: true, mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' });

		const { toolDefs } = await import('../../api/_mcp/tools/crypto-data.js');
		const tool = toolDefs.find((t) => t.name === 'crypto_data');
		const result = await tool.handler({ provider: providerId, endpoint: endpointId, params: { x: 1 } }, {}, null);

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent.provider).toBe(providerId);
		expect(result.structuredContent.endpoint).toBe(endpointId);
		expect(result.structuredContent.data).toEqual({ fixture: true, mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' });
		expect(executeUpstreamMock).toHaveBeenCalledTimes(1);
	});

	it('throws a -32402 payment-required error naming the REST URL + price when the free quota is exhausted', async () => {
		const { ENDPOINT_INDEX } = await import('../../api/v1/_providers.js');
		const [pairKey] = [...ENDPOINT_INDEX.keys()].filter((k) => {
			const { endpoint } = ENDPOINT_INDEX.get(k);
			return Boolean(endpoint.free);
		});
		const [providerId, endpointId] = pairKey.split('/');
		minOk = false;

		const { toolDefs } = await import('../../api/_mcp/tools/crypto-data.js');
		const tool = toolDefs.find((t) => t.name === 'crypto_data');

		await expect(tool.handler({ provider: providerId, endpoint: endpointId }, {}, null)).rejects.toMatchObject({
			code: -32402,
			data: expect.objectContaining({
				scheme: 'x402',
				provider: providerId,
				endpoint: endpointId,
				pay_via: expect.stringContaining(`/api/v1/x/${providerId}/${endpointId}`),
			}),
		});
		expect(executeUpstreamMock).not.toHaveBeenCalled();
	});

	it('throws -32402 immediately for an endpoint with no free tier at all (no quota check needed)', async () => {
		const { ENDPOINT_INDEX } = await import('../../api/v1/_providers.js');
		const [pairKey] = [...ENDPOINT_INDEX.keys()].filter((k) => {
			const { endpoint } = ENDPOINT_INDEX.get(k);
			return !endpoint.free;
		});
		if (!pairKey) return; // every registered endpoint currently free-tiers — nothing to assert
		const [providerId, endpointId] = pairKey.split('/');

		const { toolDefs } = await import('../../api/_mcp/tools/crypto-data.js');
		const tool = toolDefs.find((t) => t.name === 'crypto_data');
		await expect(tool.handler({ provider: providerId, endpoint: endpointId }, {}, null)).rejects.toMatchObject({ code: -32402 });
	});
});

// ── token_snapshot ──────────────────────────────────────────────────────────
describe('token_snapshot tool', () => {
	const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

	it('rejects a missing mint', async () => {
		const { toolDefs } = await import('../../api/_mcp/tools/crypto-data.js');
		const tool = toolDefs.find((t) => t.name === 'token_snapshot');
		const result = await tool.handler({ mint: '' }, {}, null);
		expect(result.isError).toBe(true);
	});

	it('merges partial provider availability (one ok, one fails) without throwing', async () => {
		const { ENDPOINT_INDEX } = await import('../../api/v1/_providers.js');
		const hasDexscreener = ENDPOINT_INDEX.has('dexscreener/token');
		const hasJupiter = ENDPOINT_INDEX.has('jupiter/price');
		if (!hasDexscreener && !hasJupiter) return; // neither provider registered on this run — nothing to fan out to

		executeUpstreamMock.mockImplementation(async ({ provider }) => {
			if (provider.id === 'dexscreener') return { pairs: [{ priceUsd: '0.001' }] };
			throw Object.assign(new Error('jupiter down'), { status: 502 });
		});

		const { toolDefs } = await import('../../api/_mcp/tools/crypto-data.js');
		const tool = toolDefs.find((t) => t.name === 'token_snapshot');
		const result = await tool.handler({ mint: MINT }, {}, null);

		expect(result.isError).toBeFalsy();
		const snap = result.structuredContent;
		expect(snap.mint).toBe(MINT);
		if (hasDexscreener) {
			expect(snap.sources).toContain('dexscreener');
			expect(snap.dexscreener).toEqual({ pairs: [{ priceUsd: '0.001' }] });
		}
		if (hasJupiter) {
			expect(snap.failed.some((f) => f.provider === 'jupiter')).toBe(true);
		}
	});

	it('degrades to skipped (not an error) when a candidate provider is not registered on this deployment', async () => {
		vi.doMock('../../api/v1/_providers.js', async (importOriginal) => {
			const actual = await importOriginal();
			const index = new Map(actual.ENDPOINT_INDEX);
			index.delete('jupiter/price'); // simulate jupiter/price not yet registered
			return { ...actual, ENDPOINT_INDEX: index };
		});
		vi.resetModules();
		executeUpstreamMock.mockResolvedValue({ ok: true });

		const { toolDefs } = await import('../../api/_mcp/tools/crypto-data.js');
		const tool = toolDefs.find((t) => t.name === 'token_snapshot');
		const result = await tool.handler({ mint: MINT }, {}, null);

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent.skipped.some((s) => s.provider === 'jupiter')).toBe(true);

		vi.doUnmock('../../api/v1/_providers.js');
		vi.resetModules();
	});
});
