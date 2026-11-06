// Tests for the free symbol-availability check (api/crypto/symbol.js).
//
// The core collision logic (checkSymbols) takes an injected `fetchImpl`, so we
// exercise exact vs fuzzy matching, available/taken counts, and graceful
// degradation against real-shaped DexScreener search payloads — no live network.
// Handler-level tests drive the default export with mock req/res to prove cap
// enforcement, empty-list handling, and the happy-path response shape.
//
// Fixtures use made-up tickers + synthetic mints, except $THREE (three.ws's own
// coin, CA FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import handler, { checkSymbols, symbolSimilarity, SYMBOL_CAP } from '../../api/crypto/symbol.js';

// ── Fixtures: trimmed DexScreener /latest/dex/search shapes, keyed by query ───
function pair(symbol, name, mint, { chainId = 'solana', liq = 12000 } = {}) {
	return {
		chainId,
		dexId: 'pumpswap',
		baseToken: { address: mint, name, symbol },
		quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
		liquidity: { usd: liq },
	};
}

const FIXTURES = {
	// exact collision — same ticker already live
	three: [pair('three', 'three.ws', 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')],
	// fuzzy only — "MOONZ" vs "MOONS" (trigram Jaccard ≈ 0.5) + an unrelated token
	moonz: [
		pair('MOONS', 'Moons', 'MoonsSynthetic1111111111111111111111111111'),
		pair('LAMBO', 'Lambo', 'LamboSynthetic1111111111111111111111111111'),
	],
	// clean — nothing similar comes back
	blergz: [pair('WIDGET', 'Widget', 'WidgetSynthetic11111111111111111111111111')],
	// two pairs for the same mint at different liquidity → dedupe keeps richest
	zorp: [
		pair('ZORP', 'Zorp', 'ZorpSynthetic11111111111111111111111111111', { liq: 500 }),
		pair('ZORP', 'Zorp', 'ZorpSynthetic11111111111111111111111111111', { liq: 90000 }),
	],
	// lives only on base — used to prove the chain filter
	crosschain: [pair('CROSSCHAIN', 'Cross', 'CrossSynthetic111111111111111111111111111', { chainId: 'base' })],
};

function fakeFetch(url) {
	const q = (new URL(url).searchParams.get('q') || '').toLowerCase();
	const pairs = FIXTURES[q] ?? [];
	return Promise.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: '1.0.0', pairs }) });
}

function downFetch() {
	return Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
}

// ── req/res mocks ─────────────────────────────────────────────────────────
function makeReq({ method = 'GET', url = '/api/crypto/symbol', headers = {}, body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = { host: 'localhost', ...(body ? { 'content-type': 'application/json' } : {}), ...headers };
	base.socket = { remoteAddress: '203.0.113.7' };
	return base;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
			this.headersSent = true;
		},
	};
}

async function invoke(reqOpts) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	return { res, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

afterEach(() => vi.unstubAllGlobals());

// ── Trigram similarity ─────────────────────────────────────────────────────
describe('symbolSimilarity', () => {
	it('scores identical tickers 1.0 (case-insensitive)', () => {
		expect(symbolSimilarity('MOON', 'moon')).toBe(1);
	});
	it('scores look-alikes above the fuzzy floor', () => {
		expect(symbolSimilarity('MOONZ', 'MOONS')).toBeGreaterThanOrEqual(0.4);
	});
	it('scores unrelated tickers near zero', () => {
		expect(symbolSimilarity('MOON', 'LAMBO')).toBeLessThan(0.4);
	});
	it('returns 0 for empty input', () => {
		expect(symbolSimilarity('', 'MOON')).toBe(0);
	});
});

// ── Core collision logic ───────────────────────────────────────────────────
describe('checkSymbols', () => {
	it('flags an exact collision as taken', async () => {
		const out = await checkSymbols({ symbols: ['THREE'], fetchImpl: fakeFetch });
		const r = out.results[0];
		expect(r.available).toBe(false);
		expect(r.exactCollisions).toHaveLength(1);
		expect(r.exactCollisions[0].mint).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(out.takenCount).toBe(1);
		expect(out.availableCount).toBe(0);
	});

	it('reports a fuzzy look-alike but leaves the symbol available', async () => {
		const out = await checkSymbols({ symbols: ['MOONZ'], fetchImpl: fakeFetch });
		const r = out.results[0];
		expect(r.available).toBe(true);
		expect(r.exactCollisions).toHaveLength(0);
		expect(r.fuzzyCollisions.map((c) => c.symbol)).toContain('MOONS');
		// The unrelated LAMBO token is below the floor and excluded.
		expect(r.fuzzyCollisions.map((c) => c.symbol)).not.toContain('LAMBO');
		expect(r.fuzzyCollisions[0].similarity).toBeGreaterThanOrEqual(0.4);
	});

	it('returns available with no collisions for a clean ticker', async () => {
		const out = await checkSymbols({ symbols: ['BLERGZ'], fetchImpl: fakeFetch });
		expect(out.results[0]).toMatchObject({ available: true, exactCollisions: [], fuzzyCollisions: [] });
		expect(out.availableCount).toBe(1);
	});

	it('computes available/taken counts across a mixed batch', async () => {
		const out = await checkSymbols({ symbols: ['THREE', 'MOONZ', 'BLERGZ'], fetchImpl: fakeFetch });
		expect(out.availableCount).toBe(2);
		expect(out.takenCount).toBe(1);
		expect(out.results).toHaveLength(3);
	});

	it('de-duplicates the input case-insensitively', async () => {
		const out = await checkSymbols({ symbols: ['THREE', 'three', ' $three '], fetchImpl: fakeFetch });
		expect(out.results).toHaveLength(1);
	});

	it('dedupes multiple pairs for one mint (keeps the record)', async () => {
		const out = await checkSymbols({ symbols: ['ZORP'], fetchImpl: fakeFetch });
		expect(out.results[0].exactCollisions).toHaveLength(1);
	});

	it('filters collisions by chain when requested', async () => {
		const onBase = await checkSymbols({ symbols: ['CROSSCHAIN'], chain: 'base', fetchImpl: fakeFetch });
		expect(onBase.results[0].available).toBe(false);
		const onSolana = await checkSymbols({ symbols: ['CROSSCHAIN'], chain: 'solana', fetchImpl: fakeFetch });
		expect(onSolana.results[0].available).toBe(true);
	});

	it('degrades to 200 with a note when the registry is down — never a false green light', async () => {
		const out = await checkSymbols({ symbols: ['THREE'], fetchImpl: downFetch });
		const r = out.results[0];
		expect(r.available).toBeNull();
		expect(r.degraded).toBe(true);
		expect(r.note).toMatch(/unavailable/i);
		expect(out.degraded).toBe(true);
		// Unverifiable symbols count as neither available nor taken.
		expect(out.availableCount).toBe(0);
		expect(out.takenCount).toBe(0);
	});
});

// ── Handler: validation + happy path ───────────────────────────────────────
describe('GET/POST /api/crypto/symbol', () => {
	it('400s an empty symbol list with the cap and an example', async () => {
		const { status, body } = await invoke({ url: '/api/crypto/symbol' });
		expect(status).toBe(400);
		expect(body.error).toBe('missing_symbols');
		expect(body.cap).toBe(SYMBOL_CAP);
		expect(body.example.symbols).toBeInstanceOf(Array);
	});

	it('400s an oversized list with the cap', async () => {
		const symbols = Array.from({ length: SYMBOL_CAP + 1 }, (_, i) => `SYM${i}`);
		const { status, body } = await invoke({ method: 'POST', body: { symbols } });
		expect(status).toBe(400);
		expect(body.error).toBe('too_many_symbols');
		expect(body.cap).toBe(SYMBOL_CAP);
	});

	it('serves a real GET batch with rate-limit headers', async () => {
		vi.stubGlobal('fetch', fakeFetch);
		const { status, body, res } = await invoke({ url: '/api/crypto/symbol?symbols=THREE,MOONZ,BLERGZ' });
		expect(status).toBe(200);
		expect(body.availableCount).toBe(2);
		expect(body.takenCount).toBe(1);
		expect(typeof body.ts).toBe('string');
		expect(res.headers['ratelimit-limit']).toBeDefined();
	});

	it('accepts a POST body with a chain filter', async () => {
		vi.stubGlobal('fetch', fakeFetch);
		const { status, body } = await invoke({
			method: 'POST',
			body: { symbols: ['THREE'], chain: 'solana' },
		});
		expect(status).toBe(200);
		expect(body.chain).toBe('solana');
		expect(body.results[0].available).toBe(false);
	});
});
