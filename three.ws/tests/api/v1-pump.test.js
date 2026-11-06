// GET /api/v1/pump/{trending,curve,launches,whales} — the free pump.fun market
// data family under the versioned, cataloged /api/v1 surface (prompt 06 of the
// x402-catalog campaign). `search` ships as a sibling file
// (api/v1/pump/search.js) covered by tests/api/v1-pump-search.test.js — this
// file covers the other four actions plus their catalog registration.
//
// Each endpoint is a thin wrapper over an already-free, already-shared engine:
//   trending → api/_lib/crypto-trending.js composeTrending (same as /api/crypto/trending)
//   curve    → api/_lib/pump-bonding.js getBondingStatus (same as /api/crypto/bonding)
//   launches → api/_lib/pump-agent-launches.js queryAgentLaunches (same as /api/pump/launches)
//   whales   → api/_lib/pump-whale-scan.js scanTokenWhales/scanMarketWhales (same as /api/crypto/whales)
//
// Tests mock each engine at the module boundary with real-shaped fixtures and
// exercise the real handler: a real-shaped hit, validation, honest error
// surfacing (upstream down → 503, never empty-array fakery), the per-IP rate
// limit, and catalog registration matching the live route files.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

let quotaOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		publicIp: async () =>
			quotaOk
				? { success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }
				: { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.11',
}));

let trendingImpl = async () => ({ window: '1h', tokens: [], count: 0, ts: new Date().toISOString(), sources: [] });
vi.mock('../../api/_lib/crypto-trending.js', async (importActual) => {
	const actual = await importActual();
	return { ...actual, composeTrending: (...a) => trendingImpl(...a) };
});

let bondingImpl = async () => ({ kind: 'not_found' });
vi.mock('../../api/_lib/pump-bonding.js', () => ({
	getBondingStatus: (...a) => bondingImpl(...a),
}));

let launchesImpl = async () => ({ launches: [], has_more: false });
vi.mock('../../api/_lib/pump-agent-launches.js', () => ({
	queryAgentLaunches: (...a) => launchesImpl(...a),
	TIER_RANK: { prime: 5, strong: 4, lean: 3, watch: 2, avoid: 1 },
}));

let tokenWhalesImpl = async () => ({
	scope: 'token', mint: THREE_MINT, whales: [], whaleCount: 0, totalSolMoved: 0,
	signal: 'neutral', ts: new Date().toISOString(), source: 'pump.fun',
});
let marketWhalesImpl = async () => ({
	scope: 'market', mint: null, whales: [], whaleCount: 0, totalSolMoved: 0,
	signal: 'neutral', ts: new Date().toISOString(), source: 'pump.fun',
});
vi.mock('../../api/_lib/pump-whale-scan.js', () => ({
	scanTokenWhales: (...a) => tokenWhalesImpl(...a),
	scanMarketWhales: (...a) => marketWhalesImpl(...a),
	WHALE_MIN_SOL_DEFAULT: 5,
}));

beforeEach(() => {
	quotaOk = true;
});
afterEach(() => {
	vi.restoreAllMocks();
});

function makeReq({ url, host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function dispatch(modulePath, url) {
	const mod = await import(modulePath);
	const res = makeRes();
	await mod.default(makeReq({ url }), res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

// ── trending ─────────────────────────────────────────────────────────────────

describe('GET /api/v1/pump/trending', () => {
	it('returns a real-shaped ranked list', async () => {
		trendingImpl = async ({ window, limit, source }) => {
			expect(window).toBe('1h');
			expect(limit).toBe(20);
			expect(source).toBe('all');
			return {
				window: '1h',
				tokens: [{ mint: THREE_MINT, symbol: 'three', name: 'three.ws', marketCapUsd: 4_200_000, volumeUsd: 120_000, change: 12.4, score: 87.5, url: 'https://pump.fun/coin/' + THREE_MINT }],
				count: 1,
				ts: '2026-07-08T00:00:00.000Z',
				sources: ['pumpfun', 'dexscreener'],
			};
		};
		const { res, body } = await dispatch('../../api/v1/pump/trending.js', '/api/v1/pump/trending');
		expect(res.statusCode).toBe(200);
		expect(body.data.tokens).toHaveLength(1);
		expect(body.data.tokens[0].mint).toBe(THREE_MINT);
		expect(body.data.sources).toEqual(['pumpfun', 'dexscreener']);
		expect(res.getHeader('cache-control')).toMatch(/max-age=30/);
	});

	it('clamps limit to the v1-slim cap of 25 (tighter than /api/crypto/trending\'s 50)', async () => {
		trendingImpl = async ({ limit }) => {
			expect(limit).toBe(25);
			return { window: '1h', tokens: [], count: 0, ts: '', sources: [] };
		};
		await dispatch('../../api/v1/pump/trending.js', '/api/v1/pump/trending?limit=999');
	});

	it('coerces an unknown window/source to the documented defaults', async () => {
		trendingImpl = async ({ window, source }) => {
			expect(window).toBe('1h');
			expect(source).toBe('all');
			return { window: '1h', tokens: [], count: 0, ts: '', sources: [] };
		};
		await dispatch('../../api/v1/pump/trending.js', '/api/v1/pump/trending?window=bogus&source=bogus');
	});

	it('honors window=5m and source=pumpfun', async () => {
		trendingImpl = async ({ window, source }) => {
			expect(window).toBe('5m');
			expect(source).toBe('pumpfun');
			return { window: '5m', tokens: [], count: 0, ts: '', sources: [] };
		};
		await dispatch('../../api/v1/pump/trending.js', '/api/v1/pump/trending?window=5m&source=pumpfun');
	});

	it('every source down still answers 200 with an empty ranking + short cache', async () => {
		trendingImpl = async () => ({
			window: '1h', tokens: [], count: 0, ts: '2026-07-08T00:00:00.000Z', sources: [],
			note: 'All upstream market sources were unavailable — returning an empty ranking. Retry shortly.',
		});
		const { res, body } = await dispatch('../../api/v1/pump/trending.js', '/api/v1/pump/trending');
		expect(res.statusCode).toBe(200);
		expect(body.data.tokens).toEqual([]);
		expect(body.data.note).toMatch(/unavailable/);
		expect(res.getHeader('cache-control')).toMatch(/max-age=5/);
	});

	it('returns 429 when the per-IP quota is exhausted', async () => {
		quotaOk = false;
		const { res, body } = await dispatch('../../api/v1/pump/trending.js', '/api/v1/pump/trending');
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

// ── curve ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/pump/curve', () => {
	it('requires mint', async () => {
		const { res, body } = await dispatch('../../api/v1/pump/curve.js', '/api/v1/pump/curve');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects a malformed mint', async () => {
		const { res, body } = await dispatch('../../api/v1/pump/curve.js', '/api/v1/pump/curve?mint=not-base58!!');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns a real-shaped on-curve status', async () => {
		bondingImpl = async (mint) => {
			expect(mint).toBe(THREE_MINT);
			return {
				kind: 'ok',
				status: {
					onCurve: true, graduated: false, migratedTo: null,
					bondingProgressPct: 63.4, solInCurve: 41.2, tokensRemaining: 290_000_000,
					marketCapUsd: 38_000, source: 'pumpfun',
				},
			};
		};
		const { res, body } = await dispatch('../../api/v1/pump/curve.js', `/api/v1/pump/curve?mint=${THREE_MINT}`);
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			mint: THREE_MINT, onCurve: true, bondingProgressPct: 63.4, solInCurve: 41.2,
			tokensRemaining: 290_000_000, marketCapUsd: 38_000, graduated: false, migratedTo: null, source: 'pumpfun',
		});
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=15/);
	});

	it('returns a real-shaped graduated status', async () => {
		bondingImpl = async () => ({
			kind: 'ok',
			status: {
				onCurve: false, graduated: true, migratedTo: 'pumpswap',
				bondingProgressPct: 100, solInCurve: null, tokensRemaining: null,
				marketCapUsd: 4_100_000, source: 'pumpfun',
			},
		});
		const { body } = await dispatch('../../api/v1/pump/curve.js', `/api/v1/pump/curve?mint=${THREE_MINT}`);
		expect(body.data.graduated).toBe(true);
		expect(body.data.migratedTo).toBe('pumpswap');
	});

	it('400s not_pumpfun_mint for a mint pump.fun never indexed', async () => {
		bondingImpl = async () => ({ kind: 'not_found' });
		const { res, body } = await dispatch('../../api/v1/pump/curve.js', `/api/v1/pump/curve?mint=${THREE_MINT}`);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('not_pumpfun_mint');
	});

	it('503s honestly when the pump.fun feed is unreachable — never fakes a 200', async () => {
		bondingImpl = async () => ({ kind: 'upstream_down' });
		const { res, body } = await dispatch('../../api/v1/pump/curve.js', `/api/v1/pump/curve?mint=${THREE_MINT}`);
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('upstream_unavailable');
	});

	it('returns 429 when the per-IP quota is exhausted', async () => {
		quotaOk = false;
		const { res, body } = await dispatch('../../api/v1/pump/curve.js', `/api/v1/pump/curve?mint=${THREE_MINT}`);
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

// ── launches ─────────────────────────────────────────────────────────────────

describe('GET /api/v1/pump/launches', () => {
	it('returns a real-shaped launch directory page', async () => {
		launchesImpl = async ({ network, agentId, minTierParam, offset, limit }) => {
			expect(network).toBe('mainnet');
			expect(agentId).toBeNull();
			expect(minTierParam).toBe('');
			expect(offset).toBe(0);
			expect(limit).toBe(24);
			return {
				launches: [{
					mint: THREE_MINT, network: 'mainnet', name: 'three.ws', symbol: 'three',
					buyback_bps: 500, metadata_uri: 'https://example.test/meta.json', quote_mint: null,
					created_at: '2026-07-01T00:00:00.000Z',
					oracle: { score: 91, tier: 'prime', category: 'agent' },
					agent: { id: 'a1', name: 'Launch Bot', url: '/agents/a1', avatar_thumbnail_url: null, solana_address: 'So1anaAddr', solana_vanity_prefix: null, solana_vanity_suffix: null },
				}],
				has_more: true,
			};
		};
		const { res, body } = await dispatch('../../api/v1/pump/launches.js', '/api/v1/pump/launches');
		expect(res.statusCode).toBe(200);
		expect(body.data.launches).toHaveLength(1);
		expect(body.data.launches[0].mint).toBe(THREE_MINT);
		expect(body.data.has_more).toBe(true);
		expect(body.data.network).toBe('mainnet');
		expect(res.getHeader('cache-control')).toMatch(/max-age=15/);
	});

	it('clamps limit to 1..100 and parses offset/network/agent_id/min_tier', async () => {
		launchesImpl = async ({ network, agentId, minTierParam, offset, limit }) => {
			expect(network).toBe('devnet');
			expect(agentId).toBe('11111111-1111-4111-8111-111111111111');
			expect(minTierParam).toBe('prime');
			expect(offset).toBe(10);
			expect(limit).toBe(100);
			return { launches: [], has_more: false };
		};
		await dispatch(
			'../../api/v1/pump/launches.js',
			'/api/v1/pump/launches?limit=999&offset=10&network=devnet&agent_id=11111111-1111-4111-8111-111111111111&min_tier=prime',
		);
	});

	it('400s an invalid agent_id', async () => {
		const { res, body } = await dispatch('../../api/v1/pump/launches.js', '/api/v1/pump/launches?agent_id=not-a-uuid');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('400s an invalid min_tier', async () => {
		const { res, body } = await dispatch('../../api/v1/pump/launches.js', '/api/v1/pump/launches?min_tier=legendary');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns 429 when the per-IP quota is exhausted', async () => {
		quotaOk = false;
		const { res, body } = await dispatch('../../api/v1/pump/launches.js', '/api/v1/pump/launches');
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

// ── whales ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/pump/whales', () => {
	it('market scope (no mint): facts only, no bullish/bearish signal field', async () => {
		marketWhalesImpl = async ({ minSol, limit }) => {
			expect(minSol).toBe(5);
			expect(limit).toBe(5);
			return {
				scope: 'market', mint: null,
				whales: [{ wallet: 'WhaleWallet111', solMoved: 42.5, txHash: 'sig1', ts: '2026-07-08T00:00:00.000Z' }],
				whaleCount: 1, totalSolMoved: 42.5, signal: 'bullish',
				ts: '2026-07-08T00:00:01.000Z', source: 'pump.fun',
			};
		};
		const { res, body } = await dispatch('../../api/v1/pump/whales.js', '/api/v1/pump/whales');
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			scope: 'market', mint: null,
			wallets: [{ wallet: 'WhaleWallet111', solMoved: 42.5, txHash: 'sig1', ts: '2026-07-08T00:00:00.000Z' }],
			whale_count: 1, total_sol_moved: 42.5, min_sol: 5,
			ts: '2026-07-08T00:00:01.000Z', source: 'pump.fun',
		});
		expect(body.data.signal).toBeUndefined();
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=15/);
	});

	it('token scope (mint given) calls scanTokenWhales, not scanMarketWhales', async () => {
		let tokenCalled = false;
		let marketCalled = false;
		tokenWhalesImpl = async ({ mint, minSol, limit }) => {
			tokenCalled = true;
			expect(mint).toBe(THREE_MINT);
			expect(minSol).toBe(10);
			expect(limit).toBe(3);
			return { scope: 'token', mint, whales: [], whaleCount: 0, totalSolMoved: 0, signal: 'neutral', ts: '', source: 'pump.fun' };
		};
		marketWhalesImpl = async () => { marketCalled = true; return { scope: 'market', mint: null, whales: [], whaleCount: 0, totalSolMoved: 0, signal: 'neutral', ts: '', source: 'pump.fun' }; };
		const { res } = await dispatch('../../api/v1/pump/whales.js', `/api/v1/pump/whales?mint=${THREE_MINT}&minSol=10&limit=3`);
		expect(res.statusCode).toBe(200);
		expect(tokenCalled).toBe(true);
		expect(marketCalled).toBe(false);
	});

	it('defaults limit to 5 and caps it at 25', async () => {
		marketWhalesImpl = async ({ limit }) => {
			expect(limit).toBe(25);
			return { scope: 'market', mint: null, whales: [], whaleCount: 0, totalSolMoved: 0, signal: 'neutral', ts: '', source: 'pump.fun' };
		};
		await dispatch('../../api/v1/pump/whales.js', '/api/v1/pump/whales?limit=999');
	});

	it('400s an invalid mint', async () => {
		const { res, body } = await dispatch('../../api/v1/pump/whales.js', '/api/v1/pump/whales?mint=not-base58!!');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('400s an invalid minSol', async () => {
		const { res, body } = await dispatch('../../api/v1/pump/whales.js', '/api/v1/pump/whales?minSol=-1');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('surfaces a degraded upstream honestly with a note, never fake data', async () => {
		marketWhalesImpl = async () => ({
			scope: 'market', mint: null, whales: [], whaleCount: 0, totalSolMoved: 0, signal: 'neutral',
			ts: '2026-07-08T00:00:00.000Z', source: 'pump.fun', degraded: true,
		});
		const { res, body } = await dispatch('../../api/v1/pump/whales.js', '/api/v1/pump/whales');
		expect(res.statusCode).toBe(200);
		expect(body.data.wallets).toEqual([]);
		expect(body.data.note).toMatch(/temporarily unavailable/);
	});

	it('returns 429 when the per-IP quota is exhausted', async () => {
		quotaOk = false;
		const { res, body } = await dispatch('../../api/v1/pump/whales.js', '/api/v1/pump/whales');
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

// ── /api/v1 catalog ──────────────────────────────────────────────────────────

describe('/api/v1 catalog — pump.fun family', () => {
	const EXPECTED = {
		'v1.pump.trending': { path: '/api/v1/pump/trending', file: '../../api/v1/pump/trending.js' },
		'v1.pump.curve': { path: '/api/v1/pump/curve', file: '../../api/v1/pump/curve.js' },
		'v1.pump.launches': { path: '/api/v1/pump/launches', file: '../../api/v1/pump/launches.js' },
		'v1.pump.whales': { path: '/api/v1/pump/whales', file: '../../api/v1/pump/whales.js' },
	};

	it('registers all four endpoints as free, public GET, each matching a live route file', async () => {
		const { CATALOG } = await import('../../api/v1/_catalog.js');
		for (const [id, { path, file }] of Object.entries(EXPECTED)) {
			const entry = CATALOG.find((e) => e.id === id);
			expect(entry, `missing catalog entry ${id}`).toBeTruthy();
			expect(entry.method).toBe('GET');
			expect(entry.path).toBe(path);
			expect(entry.auth).toBe('public');
			expect(entry.summary).toBeTruthy();
			expect(Object.keys(entry.params).length).toBeGreaterThan(0);
			// The catalog path must resolve to a real, importable handler file.
			const mod = await import(file);
			expect(typeof mod.default).toBe('function');
		}
	});

	it('every catalog id is unique and every path is unique', async () => {
		const { CATALOG } = await import('../../api/v1/_catalog.js');
		const ids = CATALOG.map((e) => e.id);
		const paths = CATALOG.map((e) => `${e.method}:${e.path}`);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(paths).size).toBe(paths.length);
	});
});
