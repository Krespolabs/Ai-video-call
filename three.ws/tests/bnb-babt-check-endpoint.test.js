/**
 * GET /api/bnb/babt-check — integration tests.
 *
 * `../api/_lib/bnb/babt.js` and `../api/_lib/rate-limit.js` are mocked so the
 * suite runs deterministically without a live RPC/Redis (kept in its own
 * file, separate from tests/bnb-babt.test.js, because vi.mock hoists
 * per-file and would otherwise shadow the real `hasBabt` those lib tests
 * exercise directly).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const HOLDER = '0x04d1C36842430A169D132ADa68006e6Bb9E3808b';
const NON_HOLDER = '0x000000000000000000000000000000000000dEaD';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const babtState = { mode: 'holder' };
vi.mock('../api/_lib/bnb/babt.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/babt.js');
	return {
		...actual,
		hasBabt: vi.fn(async (address, network) => {
			const net = network || 'bscMainnet';
			if (babtState.mode === 'unreachable') {
				throw new actual.BabtCheckError('BABT balanceOf read failed: timeout', {
					network: net,
					contract: actual.BABT_CONTRACTS[net],
				});
			}
			return {
				address,
				network: net,
				holdsBabt: babtState.mode === 'holder',
				tokenId: babtState.mode === 'holder' ? '1316815' : null,
				contract: actual.BABT_CONTRACTS[net],
				checkedAt: new Date().toISOString(),
			};
		}),
	};
});

const { default: handler } = await import('../api/bnb/babt-check.js');

function makeReq(url) {
	return { method: 'GET', url, headers: { origin: 'https://three.ws' }, socket: { remoteAddress: '127.0.0.1' } };
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call(qs) {
	const req = makeReq(`/api/bnb/babt-check${qs}`);
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	babtState.mode = 'holder';
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/bnb/babt-check — input validation', () => {
	it('400 when address is missing', async () => {
		const r = await call('');
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('bad_request');
	});
	it('400 on a malformed address', async () => {
		const r = await call('?address=not-an-address');
		expect(r._s).toBe(400);
	});
	it('400 on a Solana address (wrong chain)', async () => {
		const r = await call('?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(r._s).toBe(400);
	});
	it('400 on an unknown network param', async () => {
		const r = await call(`?address=${HOLDER}&network=nonsense`);
		expect(r._s).toBe(400);
	});
});

describe('GET /api/bnb/babt-check — success', () => {
	it('200 with holdsBabt:true for a holder', async () => {
		const r = await call(`?address=${HOLDER}`);
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.holdsBabt).toBe(true);
		expect(body.tokenId).toBe('1316815');
		expect(body.network).toBe('bscMainnet');
		expect(body.explorer).toContain(body.contract);
	});

	it('200 with holdsBabt:false for a non-holder', async () => {
		babtState.mode = 'non-holder';
		const r = await call(`?address=${NON_HOLDER}`);
		expect(r._s).toBe(200);
		expect(r.json().holdsBabt).toBe(false);
	});

	it('200 on testnet, includes the developer-only caveat note', async () => {
		const r = await call(`?address=${HOLDER}&network=testnet`);
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.network).toBe('bscTestnet');
		expect(body.note).toMatch(/developers testing/i);
	});
});

describe('GET /api/bnb/babt-check — upstream failure', () => {
	it('502 contract_unreachable when the on-chain read fails', async () => {
		babtState.mode = 'unreachable';
		const r = await call(`?address=${HOLDER}`);
		expect(r._s).toBe(502);
		expect(r.json().error).toBe('contract_unreachable');
	});
});

describe('GET /api/bnb/babt-check — rate limiting', () => {
	it('429 when the IP bucket is exhausted', async () => {
		rl.ok = false;
		const r = await call(`?address=${HOLDER}`);
		expect(r._s).toBe(429);
	});
});

describe('GET /api/bnb/babt-check — method + CORS', () => {
	it('405 on POST', async () => {
		const req = makeReq(`/api/bnb/babt-check?address=${HOLDER}`);
		req.method = 'POST';
		const res = makeRes();
		await handler(req, res);
		expect(res._s).toBe(405);
	});
});
