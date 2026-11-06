import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';

// The payer + payee/feePayer keys and the USDC mint must be valid base58 pubkeys
// because runStreamingMcpHealth builds (and signs) a real Solana transfer locally.
// Nothing is broadcast — the mock server below never touches a chain — so this is
// a true integration test of the probe → pay → stream-read → classify → store
// path without any on-chain spend.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const { runStreamingMcpHealth } = await import('../api/_lib/x402/pipelines/streaming-mcp-health.js');

const payTo = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const AMOUNT = '10000'; // 0.01 USDC atomics

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

const RPC_RESULT = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		content: [{ type: 'text', text: 'glTF-Validator report: 0 errors' }],
		structuredContent: { numErrors: 0, numWarnings: 0, fileSize: 162852 },
	},
};

// A captured-statement SQL stub: records every tagged-template call so the test
// can assert the mcp_stream_health insert happened.
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
	};
}

// mode controls how the mock /api/mcp behaves on the PAID request.
let mode = 'healthy';
let server;
let origin;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const paid = !!req.headers['x-payment'];
		if (!paid) {
			// x402 challenge (plain agent → 402).
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(challenge()));
			return;
		}
		if (mode === 'payment_rejected') {
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(challenge()));
			return;
		}
		// Paid + accepted: settle (advertise the tx sig) and stream the JSON-RPC body.
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader(
			'x-payment-response',
			Buffer.from(JSON.stringify({ success: true, transaction: 'TESTSIG_abc123' })).toString('base64'),
		);
		const payload = JSON.stringify(RPC_RESULT);
		if (mode === 'dropped') {
			// Write a partial chunk then destroy the socket → client sees a dropped stream.
			res.write(payload.slice(0, 10));
			setTimeout(() => res.socket?.destroy(), 20);
			return;
		}
		// healthy: write in two chunks then end cleanly.
		res.write(payload.slice(0, Math.floor(payload.length / 2)));
		setTimeout(() => res.end(payload.slice(Math.floor(payload.length / 2))), 15);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	origin = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => { mode = 'healthy'; });

describe('runStreamingMcpHealth', () => {
	it('pays, stream-reads a clean response, settles, and stores health', async () => {
		mode = 'healthy';
		const sqlStub = makeSqlStub();
		const out = await runStreamingMcpHealth(baseCtx(origin, sqlStub));

		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(Number(AMOUNT));
		expect(out.txSig).toBe('TESTSIG_abc123');
		expect(out.errorMsg).toBeNull();
		expect(out.signalData.alive).toBe(true);
		expect(out.signalData.settled).toBe(true);
		expect(out.signalData.chunk_count).toBeGreaterThanOrEqual(1);
		expect(out.signalData.total_bytes).toBeGreaterThan(0);
		expect(out.signalData.stalled).toBe(false);
		expect(out.signalData.dropped).toBe(false);

		// The value sink got an INSERT into mcp_stream_health.
		const insert = sqlStub.calls.find((c) => /insert into\s+mcp_stream_health/i.test(c.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toContain(true); // healthy
	});

	it('flags a dropped connection and charges nothing was settled if settle absent', async () => {
		mode = 'dropped';
		const sqlStub = makeSqlStub();
		const out = await runStreamingMcpHealth(baseCtx(origin, sqlStub));

		expect(out.success).toBe(false);
		expect(out.signalData.dropped).toBe(true);
		expect(out.errorMsg).toMatch(/stream_dropped/);
		// Server set x-payment-response before dropping, so settlement is recorded,
		// but the stream is unhealthy → success false.
		expect(out.signalData.settled).toBe(true);
		expect(sqlStub.calls.some((c) => /insert into\s+mcp_stream_health/i.test(c.text))).toBe(true);
	});

	it('handles a 402 payment rejection on the paid call without crashing', async () => {
		mode = 'payment_rejected';
		const sqlStub = makeSqlStub();
		const out = await runStreamingMcpHealth(baseCtx(origin, sqlStub));

		expect(out.success).toBe(false);
		expect(out.amountAtomic).toBe(0);
		expect(out.errorMsg).toMatch(/payment_rejected: 402/);
		expect(out.signalData.settled).toBe(false);
	});

	it('honors the daily cap — skips paying when the price exceeds remainingCap', async () => {
		const sqlStub = makeSqlStub();
		const ctx = baseCtx(origin, sqlStub);
		ctx.remainingCap = 1; // below AMOUNT
		const out = await runStreamingMcpHealth(ctx);

		expect(out.success).toBe(false);
		expect(out.skipped).toBe(true);
		expect(out.errorMsg).toBe('cap_would_exceed');
		expect(out.amountAtomic).toBe(0);
	});

	it('degrades gracefully when the wallet is unconfigured', async () => {
		const sqlStub = makeSqlStub();
		const ctx = baseCtx(origin, sqlStub);
		ctx.buyer = null;
		// No seed env + no local wallet file in CI → loadSeedKeypair throws → skip.
		const prevSeed = process.env.X402_SEED_SOLANA_SECRET_BASE58;
		const prevAgent = process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		delete process.env.X402_SEED_SOLANA_SECRET_BASE58;
		delete process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		try {
			const out = await runStreamingMcpHealth(ctx);
			expect(out.success).toBe(false);
			expect(out.skipped).toBe(true);
			expect(out.errorMsg).toMatch(/wallet_unconfigured/);
		} finally {
			if (prevSeed !== undefined) process.env.X402_SEED_SOLANA_SECRET_BASE58 = prevSeed;
			if (prevAgent !== undefined) process.env.X402_AGENT_SOLANA_SECRET_BASE58 = prevAgent;
		}
	});
});
