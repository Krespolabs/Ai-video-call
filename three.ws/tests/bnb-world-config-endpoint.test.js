/**
 * GET /api/bnb/world-config — integration tests (prompt 16).
 *
 * `api/_lib/bnb/world-moves.js`'s `worldMovesAddress` and
 * `api/_lib/rate-limit.js` are mocked so the suite runs deterministically —
 * both the "deployed" and the honest "not deployed yet" states are exercised
 * without touching env vars or a live RPC.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const worldMovesState = { address: null };
vi.mock('../api/_lib/bnb/world-moves.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/world-moves.js');
	return {
		...actual,
		worldMovesAddress: vi.fn((network) => {
			if (!worldMovesState.address) {
				throw new actual.WorldMovesError('no WorldMoves contract deployed yet', { code: 'no_deployment' });
			}
			return worldMovesState.address;
		}),
	};
});

const { default: handler } = await import('../api/bnb/world-config.js');

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
async function call(qs = '') {
	const req = makeReq(`/api/bnb/world-config${qs}`);
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	worldMovesState.address = null;
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/bnb/world-config — not yet deployed (honest default state)', () => {
	it('200 with deployed:false, address:null when no contract is configured', async () => {
		const r = await call('?network=testnet');
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.deployed).toBe(false);
		expect(body.address).toBe(null);
		expect(body.network).toBe('bscTestnet');
		expect(body.chainId).toBe(97);
		expect(body.worldId).toBe(1);
		expect(Array.isArray(body.rpcs)).toBe(true);
		expect(body.rpcs.length).toBeGreaterThan(0);
	});
});

describe('GET /api/bnb/world-config — deployed', () => {
	it('200 with deployed:true and the configured address', async () => {
		worldMovesState.address = '0x71Ddcb9865632Ca3c4325dE0E4a92Cc0065c8aaE';
		const r = await call('?network=testnet');
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.deployed).toBe(true);
		expect(body.address).toBe('0x71Ddcb9865632Ca3c4325dE0E4a92Cc0065c8aaE');
	});

	it('defaults to mainnet when network is omitted', async () => {
		worldMovesState.address = '0x0000000000000000000000000000000000dEaD';
		const r = await call('');
		expect(r._s).toBe(200);
		expect(r.json().network).toBe('bscMainnet');
		expect(r.json().chainId).toBe(56);
	});

	it('400 on an unknown network param', async () => {
		const r = await call('?network=nonsense');
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('bad_request');
	});
});

describe('GET /api/bnb/world-config — rate limiting', () => {
	it('429 when the limiter declines', async () => {
		rl.ok = false;
		const r = await call('?network=testnet');
		expect(r._s).toBe(429);
	});
});
