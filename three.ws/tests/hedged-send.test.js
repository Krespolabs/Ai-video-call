import { describe, it, expect } from 'vitest';
import { hedgedBroadcast } from '../api/_lib/solana/hedged-send.js';

// A fake fetch factory: map url → behavior. `ok` returns a signature, `slow`
// resolves after a delay, `fail` returns an RPC error, `http` a non-200.
function makeFetch(behaviors) {
	return (url, _opts) => {
		const b = behaviors[url];
		if (!b) return Promise.reject(new Error('unmocked ' + url));
		if (b.type === 'fail') return Promise.resolve({ ok: true, json: async () => ({ error: { message: b.message || 'rpc error' } }) });
		if (b.type === 'http') return Promise.resolve({ ok: false, status: b.status || 429 });
		if (b.type === 'reject') return Promise.reject(new Error(b.message || 'network'));
		// ok / slow
		const resp = { ok: true, json: async () => ({ result: b.signature || 'SIG_' + url.slice(-4) }) };
		if (b.type === 'slow') return new Promise((r) => setTimeout(() => r(resp), b.delay ?? 50));
		return Promise.resolve(resp);
	};
}

const E = ['https://a.rpc', 'https://b.rpc', 'https://c.rpc'];

describe('hedgedBroadcast', () => {
	it('returns the first endpoint that accepts the tx', async () => {
		const fetchImpl = makeFetch({
			'https://a.rpc': { type: 'slow', delay: 80, signature: 'SIG_A' },
			'https://b.rpc': { type: 'ok', signature: 'SIG_WIN' },
			'https://c.rpc': { type: 'fail', message: '429 max usage' },
		});
		const r = await hedgedBroadcast('AQAB', E, { fetchImpl });
		expect(r.signature).toBe('SIG_WIN');
		expect(r.endpoint).toBe('https://b.rpc');
	});

	it('still lands when SOME endpoints 403/429/error — free-tier reality', async () => {
		const fetchImpl = makeFetch({
			'https://a.rpc': { type: 'http', status: 403 },
			'https://b.rpc': { type: 'reject', message: 'ECONNRESET' },
			'https://c.rpc': { type: 'ok', signature: 'SIG_C' },
		});
		const r = await hedgedBroadcast('AQAB', E, { fetchImpl });
		expect(r.signature).toBe('SIG_C');
		expect(r.accepted).toBe(1);
	});

	it('throws only when EVERY endpoint rejects, aggregating reasons', async () => {
		const fetchImpl = makeFetch({
			'https://a.rpc': { type: 'http', status: 429 },
			'https://b.rpc': { type: 'fail', message: 'blockhash not found' },
			'https://c.rpc': { type: 'reject', message: 'timeout' },
		});
		await expect(hedgedBroadcast('AQAB', E, { fetchImpl })).rejects.toThrow(/all 3 endpoints rejected/);
	});

	it('dedupes endpoints and rejects empty / bad input', async () => {
		const fetchImpl = makeFetch({ 'https://a.rpc': { type: 'ok', signature: 'SIG_A' } });
		const r = await hedgedBroadcast('AQAB', ['https://a.rpc', 'https://a.rpc'], { fetchImpl });
		expect(r.signature).toBe('SIG_A');
		await expect(hedgedBroadcast('', E, { fetchImpl })).rejects.toThrow(/rawTxBase64 required/);
		await expect(hedgedBroadcast('AQAB', [], { fetchImpl })).rejects.toThrow(/no endpoints/);
	});
});
