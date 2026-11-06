import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';

// The payTo / feePayer keys and the USDC mint must be valid base58 pubkeys
// because runCircuitBreaker settles a REAL Solana transfer locally via payX402
// (build + sign). Nothing is broadcast — the mock server below never touches a
// chain — so this is a true integration test of the probe → cross-network
// verify → pay → settle → store path with no on-chain spend.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const { runCircuitBreaker } = await import('../api/_lib/x402/pipelines/circuit-breaker.js');

const payToSol = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const AMOUNT = '1000'; // $0.001 USDC atomics

function solanaAccept() {
	return { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC, payTo: payToSol, amount: AMOUNT, extra: { name: 'USDC', decimals: 6, feePayer } };
}
function baseAccept() {
	return { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDCbase', payTo: '0x1111111111111111111111111111111111111111', amount: AMOUNT, extra: { name: 'USD Coin', version: '2', decimals: 6 } };
}
function bscAccept() {
	return { scheme: 'direct', network: 'eip155:56', asset: '0xUSDCbsc', payTo: '0x2222222222222222222222222222222222222222', amount: AMOUNT, extra: { name: 'Binance-Peg USD Coin', decimals: 6, contract: '0x2222222222222222222222222222222222222222', method: 'pay(bytes32)' } };
}

// `accepts` controls which network routes the mock 402 challenge advertises.
let accepts = [];
let server;
let origin;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const paid = !!req.headers['x-payment'];
		if (!paid) {
			// x402 challenge — advertise the configured network routes.
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ x402Version: 2, error: 'payment required', resource: `http://127.0.0.1/api/x402/dance-tip`, accepts }));
			return;
		}
		// Paid + accepted: settle (advertise the tx sig) and return the ticket.
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json');
		res.setHeader('x-payment-response', Buffer.from(JSON.stringify({ success: true, transaction: 'CBTESTSIG_xyz' })).toString('base64'));
		res.end(JSON.stringify({ ok: true, ticketId: 'tkt_cb', dancer: '4', dance: 'hiphop' }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	origin = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => { accepts = [solanaAccept(), baseAccept(), bscAccept()]; });

function makeSqlStub() {
	const calls = [];
	const sql = (strings, ...values) => {
		calls.push({ text: strings.join('?'), values });
		return Promise.resolve([]);
	};
	return { sql, calls };
}

function baseCtx(sqlStub) {
	return {
		origin,
		buyer: Keypair.generate(),
		conn: { getAccountInfo: async () => null }, // receiver ATA missing → create ix
		blockhash: '11111111111111111111111111111111',
		mintInfo: { decimals: 6 },
		remainingCap: 5_000_000,
		sql: sqlStub.sql,
		log: { info() {}, warn() {} },
		runId: '00000000-0000-0000-0000-000000000000',
	};
}

describe('runCircuitBreaker', () => {
	it('verifies all three routes, settles Solana, and upserts per-network status', async () => {
		const sqlStub = makeSqlStub();
		const out = await runCircuitBreaker(baseCtx(sqlStub));

		expect(out.success).toBe(true);
		expect(out.errorMsg).toBeNull();
		expect(out.amountAtomic).toBe(Number(AMOUNT));
		expect(out.txSig).toBe('CBTESTSIG_xyz');
		expect(out.signalData.tripped).toBe(false);
		expect(out.signalData.all_routes_ok).toBe(true);
		expect(out.signalData.routes_ok).toBe(3);
		expect(out.signalData.solana_settled).toBe(true);

		// One x402_circuit_breaker upsert per network (downstream: ops/health).
		const upserts = sqlStub.calls.filter((c) => /insert into\s+x402_circuit_breaker/i.test(c.text));
		expect(upserts.length).toBe(3);
		// The Solana row carries the settlement signature.
		expect(sqlStub.calls.some((c) => c.values.includes('CBTESTSIG_xyz'))).toBe(true);
	});

	it('trips when a network route is not advertised (BSC missing)', async () => {
		accepts = [solanaAccept(), baseAccept()]; // no BSC
		const sqlStub = makeSqlStub();
		const out = await runCircuitBreaker(baseCtx(sqlStub));

		expect(out.success).toBe(false);
		expect(out.signalData.tripped).toBe(true);
		expect(out.signalData.routes_ok).toBe(2);
		expect(out.signalData.solana_settled).toBe(true); // Solana still settled
		expect(out.errorMsg).toMatch(/breaker_tripped/);
		// Still records all three networks so the dashboard shows BSC as down.
		expect(sqlStub.calls.filter((c) => /insert into\s+x402_circuit_breaker/i.test(c.text)).length).toBe(3);
	});

	it('trips when a route is malformed (Solana accept missing feePayer)', async () => {
		const bad = solanaAccept(); delete bad.extra.feePayer;
		accepts = [bad, baseAccept(), bscAccept()];
		const sqlStub = makeSqlStub();
		const out = await runCircuitBreaker(baseCtx(sqlStub));

		expect(out.success).toBe(false);
		expect(out.signalData.tripped).toBe(true);
		// Malformed Solana route is not route_ok → not settled.
		expect(out.signalData.solana_settled).toBe(false);
		const sol = out.signalData.networks.find((n) => /solana/.test(n.network));
		expect(sol.route_ok).toBe(false);
	});

	it('records a trip across all networks when the probe never returns 402', async () => {
		accepts = []; // server still 402s, but with no routes → all routes fail
		const sqlStub = makeSqlStub();
		const out = await runCircuitBreaker(baseCtx(sqlStub));

		expect(out.success).toBe(false);
		expect(out.signalData.routes_ok).toBe(0);
		expect(out.signalData.solana_settled).toBe(false);
	});

	it('exits gracefully (no throw) when the wallet is unconfigured', async () => {
		const sqlStub = makeSqlStub();
		const ctx = baseCtx(sqlStub);
		ctx.buyer = null;
		const out = await runCircuitBreaker(ctx);

		expect(out.success).toBe(false);
		expect(out.errorMsg).toBe('wallet_unconfigured');
		expect(out.amountAtomic).toBe(0);
	});
});
