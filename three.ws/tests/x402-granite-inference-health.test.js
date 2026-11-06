import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';

// The payer + payee/feePayer keys and the USDC mint must be valid base58 pubkeys
// because runGraniteHealth builds (and signs) a real Solana USDC transfer
// locally. Nothing is broadcast — the mock /api/ibm-mcp below never touches a
// chain — so this is a true integration test of the probe → pay → summarise →
// store path without any on-chain spend.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const {
	runGraniteHealth,
	summarizeGraniteHealth,
	GRANITE_HEALTH_BATCH,
	GRANITE_HEALTH_TOOLS,
} = await import('../api/_lib/x402/granite-health.js');

const payTo = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const AMOUNT = '140000'; // 0.14 USDC atomics — the summed batch price

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

// A healthy batched JSON-RPC response — one entry per tool, keyed by id == tool.
function healthyBatch() {
	const usage = (p, c) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });
	const sc = {
		ibm_granite_chat: { ok: true, text: 'OK', usage: usage(12, 3) },
		ibm_granite_code: { ok: true, text: 'adds a and b', usage: usage(20, 10) },
		ibm_granite_embed: { ok: true, vectors: [[0.1, 0.2, 0.3]], dimensions: 768, inputCount: 1 },
		ibm_granite_analyze: { ok: true, summary: 'nominal', usage: usage(30, 25) },
		ibm_granite_forecast: { ok: true, forecast: [{ timestamp: 'x', value: 1 }], forecastSteps: 12, inputWindow: 512 },
	};
	return GRANITE_HEALTH_TOOLS.map((t) => ({
		jsonrpc: '2.0', id: t,
		result: { content: [{ type: 'text', text: 'ok' }], structuredContent: sc[t] },
	}));
}

// A degraded batch: chat returns a JSON-RPC error (watsonx down), the rest ok.
function degradedBatch() {
	return healthyBatch().map((m) =>
		m.id === 'ibm_granite_chat'
			? { jsonrpc: '2.0', id: 'ibm_granite_chat', error: { code: -32000, message: 'watsonx_unavailable' } }
			: m,
	);
}

function makeSqlStub() {
	const calls = [];
	const sql = (strings, ...values) => {
		calls.push({ text: strings.join('?'), values });
		return Promise.resolve([]);
	};
	return { sql, calls };
}

function baseCtx(origin, sqlStub) {
	return {
		origin,
		buyer: Keypair.generate(),
		conn: { getAccountInfo: async () => null }, // null → "create the ATA", fine
		blockhash: '11111111111111111111111111111111',
		mintInfo: { decimals: 6 },
		redis: null,
		sql: sqlStub.sql,
		log: { info() {}, warn() {} },
		runId: '00000000-0000-0000-0000-000000000000',
		remainingCap: 1_000_000,
	};
}

let mode = 'healthy';
let server;
let origin;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const paid = !!req.headers['x-payment'];
		if (!paid || mode === 'payment_rejected') {
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(challenge()));
			return;
		}
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json');
		res.setHeader(
			'x-payment-response',
			Buffer.from(JSON.stringify({ success: true, transaction: 'TESTSIG_granite' })).toString('base64'),
		);
		res.end(JSON.stringify(mode === 'degraded' ? degradedBatch() : healthyBatch()));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { mode = 'healthy'; });

describe('granite-health canary batch', () => {
	it('invokes all five paid tools with valid arguments', () => {
		expect(GRANITE_HEALTH_BATCH).toHaveLength(5);
		for (const t of GRANITE_HEALTH_TOOLS) {
			const m = GRANITE_HEALTH_BATCH.find((x) => x.id === t);
			expect(m.method).toBe('tools/call');
			expect(m.params.name).toBe(t);
			expect(m.params.arguments).toBeTruthy();
		}
	});

	it('sends a full 512-point context window for the forecast tool', () => {
		const fc = GRANITE_HEALTH_BATCH.find((x) => x.id === 'ibm_granite_forecast').params.arguments;
		expect(fc.timestamps).toHaveLength(512);
		expect(fc.values).toHaveLength(512);
		expect(fc.timestamps.length).toBe(fc.values.length);
	});
});

describe('summarizeGraniteHealth', () => {
	it('tallies tool health, schema conformance, and token throughput', () => {
		const s = summarizeGraniteHealth(healthyBatch());
		expect(s.tools_ok).toBe(5);
		expect(s.tools_failed).toBe(0);
		expect(s.schema_ok_count).toBe(5);
		expect(s.all_healthy).toBe(true);
		expect(s.watsonx_responding).toBe(true);
		expect(s.total_tokens).toBe(100);
		expect(s.embed_dimensions).toBe(768);
		expect(s.forecast_steps).toBe(12);
	});

	it('flags per-tool failures and never throws on null input', () => {
		const d = summarizeGraniteHealth(degradedBatch());
		expect(d.tools_ok).toBe(4);
		expect(d.tools_failed).toBe(1);
		expect(d.all_healthy).toBe(false);
		expect(d.watsonx_responding).toBe(true);
		expect(d.per_tool.ibm_granite_chat.error).toBe('watsonx_unavailable');

		const e = summarizeGraniteHealth(null);
		expect(e.tools_failed).toBe(5);
		expect(e.all_healthy).toBe(false);
		expect(e.watsonx_responding).toBe(false);
	});
});

describe('runGraniteHealth', () => {
	it('pays one batch call, settles, summarises, and stores the verdict', async () => {
		mode = 'healthy';
		const sqlStub = makeSqlStub();
		const out = await runGraniteHealth(baseCtx(origin, sqlStub));

		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(Number(AMOUNT));
		expect(out.txSig).toBe('TESTSIG_granite');
		expect(out.errorMsg).toBeNull();
		expect(out.signalData.all_healthy).toBe(true);
		expect(out.signalData.total_tokens).toBe(100);

		const insert = sqlStub.calls.find((c) => /insert into\s+granite_inference_health/i.test(c.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toContain(true); // all_healthy
	});

	it('records a degraded verdict (and an errorMsg) when a tool fails but payment settles', async () => {
		mode = 'degraded';
		const sqlStub = makeSqlStub();
		const out = await runGraniteHealth(baseCtx(origin, sqlStub));

		expect(out.success).toBe(true); // HTTP 200 — the call settled
		expect(out.signalData.all_healthy).toBe(false);
		expect(out.signalData.tools_failed).toBe(1);
		expect(out.errorMsg).toMatch(/granite_tools_failed:1/);
		expect(sqlStub.calls.some((c) => /insert into\s+granite_inference_health/i.test(c.text))).toBe(true);
	});

	it('handles a 402 payment rejection without crashing or storing', async () => {
		mode = 'payment_rejected';
		const sqlStub = makeSqlStub();
		const out = await runGraniteHealth(baseCtx(origin, sqlStub));

		expect(out.success).toBe(false);
		expect(out.amountAtomic).toBe(0);
		expect(out.errorMsg).toMatch(/http_402/);
		expect(sqlStub.calls.some((c) => /insert into\s+granite_inference_health/i.test(c.text))).toBe(false);
	});

	it('honors the daily cap — skips paying when the price exceeds remainingCap', async () => {
		mode = 'healthy';
		const sqlStub = makeSqlStub();
		const ctx = baseCtx(origin, sqlStub);
		ctx.remainingCap = 1; // below AMOUNT
		const out = await runGraniteHealth(ctx);

		expect(out.success).toBe(false);
		expect(out.skipped).toBe(true);
		expect(out.errorMsg).toBe('cap_would_exceed');
		expect(out.amountAtomic).toBe(0);
	});

	it('degrades gracefully when the wallet is unconfigured', async () => {
		const sqlStub = makeSqlStub();
		const ctx = baseCtx(origin, sqlStub);
		ctx.buyer = null;
		ctx.conn = null; // force the bootstrap path → loadSeedKeypair throws → skip
		const prevSeed = process.env.X402_SEED_SOLANA_SECRET_BASE58;
		const prevAgent = process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		delete process.env.X402_SEED_SOLANA_SECRET_BASE58;
		delete process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		try {
			const out = await runGraniteHealth(ctx);
			expect(out.success).toBe(false);
			expect(out.skipped).toBe(true);
			expect(out.errorMsg).toMatch(/seed keypair not configured/);
		} finally {
			if (prevSeed !== undefined) process.env.X402_SEED_SOLANA_SECRET_BASE58 = prevSeed;
			if (prevAgent !== undefined) process.env.X402_AGENT_SOLANA_SECRET_BASE58 = prevAgent;
		}
	});

	it('is registered in the autonomous self-registry with the expected wiring', async () => {
		const { getSelfRegistry } = await import('../api/_lib/x402/autonomous-registry.js');
		const entry = getSelfRegistry().find((e) => e.id === 'granite-inference-health');
		expect(entry).toBeTruthy();
		expect(entry.endpoint).toBe('/api/ibm-mcp');
		expect(entry.pipeline).toBe('health');
		expect(entry.enabled).toBe(true);
		expect(typeof entry.run).toBe('function');
		expect(entry.cooldown_s).toBe(21600);
	});
});
