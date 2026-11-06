import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

// The payer + payee/feePayer keys and the USDC mint must be valid base58 pubkeys
// because runIdempotencyAudit builds (and signs) a real Solana transfer locally.
// Nothing is broadcast — the local server below never touches a chain — so this
// is a true integration test of the probe → pay → replay → classify → store path
// without any on-chain spend.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const { runIdempotencyAudit } = await import(
	'../api/_lib/x402/pipelines/payment-proof-idempotency-audit.js'
);

const payTo = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const AMOUNT = '1000'; // 0.001 USDC atomics — matches the real model-check price.

function challenge() {
	return {
		x402Version: 2,
		error: 'payment required',
		accepts: [{
			scheme: 'exact',
			network: 'solana:mainnet',
			asset: USDC,
			payTo,
			amount: AMOUNT,
			extra: { feePayer },
		}],
	};
}

// A captured-statement SQL stub: records every tagged-template call so the test
// can assert the x402_idempotency_audit insert happened and inspect its values.
function makeSqlStub() {
	const calls = [];
	const sql = (strings, ...values) => {
		const text = strings.join('?');
		calls.push({ text, values });
		return Promise.resolve([]);
	};
	return { sql, calls };
}

function baseCtx(origin, sqlStub) {
	return {
		origin,
		buyer: Keypair.generate(),
		// getAccountInfo(receiverAta) → null means "create the ATA", which is fine.
		conn: { getAccountInfo: async () => null },
		blockhash: '11111111111111111111111111111111',
		mintInfo: { decimals: 6 },
		redis: null,
		sql: sqlStub.sql,
		log: { info() {}, warn() {} },
		runId: '00000000-0000-0000-0000-000000000000',
		remainingCap: 1_000_000,
		// Drive the replay loop fast — no real cross-replica propagation here.
		replayAttempts: 3,
		replayBackoffMs: 5,
	};
}

function proofHash(header) {
	return createHash('sha256').update(String(header)).digest('hex');
}

// mode controls how the local /api/x402/model-check emulator behaves.
//   'idempotent' — real replay: same proof returns the cached 200 + replay marker.
//   'conflict'   — second submission rejected with a 409 conflict marker.
//   'broken'     — NO idempotency: every paid call settles a fresh distinct tx.
//   'reject'     — paid call is rejected with a fresh 402 (never settles).
let mode = 'idempotent';
let server;
let origin;
// proofHash → { tx } for the idempotent emulator's cache.
let store;
let settleCounter;

function newTx() {
	settleCounter += 1;
	return `TESTSIG_${settleCounter}`;
}

function settleHeaders(res, tx) {
	res.setHeader(
		'x-payment-response',
		Buffer.from(JSON.stringify({ success: true, transaction: tx })).toString('base64'),
	);
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const payment = req.headers['x-payment'];
		if (!payment) {
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(challenge()));
			return;
		}
		const hash = proofHash(payment);

		if (mode === 'reject') {
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(challenge()));
			return;
		}

		if (mode === 'broken') {
			// Always settle a brand-new tx — the failure the audit must catch.
			const tx = newTx();
			res.statusCode = 200;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			settleHeaders(res, tx);
			res.end(JSON.stringify({ ok: true, tx }));
			return;
		}

		// idempotent / conflict: first sighting settles + caches; a repeat replays.
		const cached = store.get(hash);
		if (!cached) {
			const tx = newTx();
			store.set(hash, { tx });
			res.statusCode = 200;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			settleHeaders(res, tx);
			res.end(JSON.stringify({ ok: true, tx }));
			return;
		}
		if (mode === 'conflict') {
			res.statusCode = 409;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			res.setHeader('x-x402-idempotent', 'conflict');
			res.end(JSON.stringify({ error: 'payment_identifier_conflict' }));
			return;
		}
		// Replay the cached 200 with the same tx and the replay marker (no resettle).
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('x-x402-idempotent', 'replay');
		settleHeaders(res, cached.tx);
		res.end(JSON.stringify({ ok: true, tx: cached.tx }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	origin = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
	mode = 'idempotent';
	store = new Map();
	settleCounter = 0;
});

describe('runIdempotencyAudit', () => {
	it('passes when the replayed proof returns a cached replay (no double settle)', async () => {
		mode = 'idempotent';
		const sqlStub = makeSqlStub();
		const out = await runIdempotencyAudit(baseCtx(origin, sqlStub));

		expect(out.success).toBe(true);
		expect(out.note).toBe('idempotent_replay');
		expect(out.amountAtomic).toBe(Number(AMOUNT)); // exactly one charge
		expect(out.txSig).toBe('TESTSIG_1');
		expect(out.errorMsg).toBeNull();
		expect(out.signalData.verdict).toBe('idempotent_replay');
		expect(out.signalData.double_settled).toBe(false);
		expect(out.signalData.second_marker).toBe('replay');
		// Exactly one on-chain settlement occurred.
		expect(settleCounter).toBe(1);

		const insert = sqlStub.calls.find((c) => /insert into\s+x402_idempotency_audit/i.test(c.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toContain('idempotent_replay');
		expect(insert.values).toContain(true); // pass
	});

	it('passes when the store rejects the replay with a 409 conflict', async () => {
		mode = 'conflict';
		const sqlStub = makeSqlStub();
		const out = await runIdempotencyAudit(baseCtx(origin, sqlStub));

		expect(out.success).toBe(true);
		expect(out.signalData.verdict).toBe('idempotent_conflict');
		expect(out.signalData.double_settled).toBe(false);
		expect(settleCounter).toBe(1);
	});

	it('FAILS and flags a double settlement when the store does not dedupe', async () => {
		mode = 'broken';
		const sqlStub = makeSqlStub();
		const out = await runIdempotencyAudit(baseCtx(origin, sqlStub));

		expect(out.success).toBe(false);
		expect(out.signalData.verdict).toBe('double_settled');
		expect(out.signalData.double_settled).toBe(true);
		expect(out.errorMsg).toMatch(/double_settlement/);
		// Two distinct settlements happened — the failure the audit exists to catch.
		expect(settleCounter).toBe(2);

		const insert = sqlStub.calls.find((c) => /insert into\s+x402_idempotency_audit/i.test(c.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toContain('double_settled');
	});

	it('records inconclusive (no spend) when the first call never settles', async () => {
		mode = 'reject';
		const sqlStub = makeSqlStub();
		const out = await runIdempotencyAudit(baseCtx(origin, sqlStub));

		expect(out.success).toBe(false);
		expect(out.amountAtomic).toBe(0);
		expect(out.signalData.verdict).toBe('inconclusive');
		expect(settleCounter).toBe(0);
		const insert = sqlStub.calls.find((c) => /insert into\s+x402_idempotency_audit/i.test(c.text));
		expect(insert.values).toContain('inconclusive');
	});

	it('honors the daily cap — skips paying when the price exceeds remainingCap', async () => {
		const sqlStub = makeSqlStub();
		const ctx = baseCtx(origin, sqlStub);
		ctx.remainingCap = 1; // below AMOUNT
		const out = await runIdempotencyAudit(ctx);

		expect(out.success).toBe(false);
		expect(out.skipped).toBe(true);
		expect(out.errorMsg).toBe('cap_would_exceed');
		expect(out.amountAtomic).toBe(0);
		expect(settleCounter).toBe(0);
	});

	it('degrades gracefully when the wallet is unconfigured', async () => {
		const sqlStub = makeSqlStub();
		const ctx = baseCtx(origin, sqlStub);
		ctx.buyer = null;
		const prevSeed = process.env.X402_SEED_SOLANA_SECRET_BASE58;
		const prevAgent = process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		delete process.env.X402_SEED_SOLANA_SECRET_BASE58;
		delete process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		try {
			const out = await runIdempotencyAudit(ctx);
			expect(out.success).toBe(false);
			expect(out.skipped).toBe(true);
			expect(out.errorMsg).toMatch(/wallet_unconfigured/);
		} finally {
			if (prevSeed !== undefined) process.env.X402_SEED_SOLANA_SECRET_BASE58 = prevSeed;
			if (prevAgent !== undefined) process.env.X402_AGENT_SOLANA_SECRET_BASE58 = prevAgent;
		}
	});
});
