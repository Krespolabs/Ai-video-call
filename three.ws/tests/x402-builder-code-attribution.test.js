import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';

// The payTo / feePayer keys and the USDC mint must be valid base58 pubkeys
// because the settlement-proof step builds + signs a REAL Solana transfer
// locally via buildPaymentTx. Nothing is broadcast — the mock server below
// never touches a chain — so this is a true integration test of the
// probe → attribution-verify → attributed-pay → settle → store path with no
// on-chain spend.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;
process.env.X402_BUILDER_CODE_APP = 'three_d_agent';
process.env.X402_BUILDER_CODE_WALLET = '3d_agent';

const { run } = await import('../api/_lib/x402/pipelines/builder-code-attribution.js');

const APP_CODE = 'three_d_agent';
const payToSol = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const AMOUNT = '1000'; // $0.001 USDC atomics

function builderCodeExtension(a) {
	return { info: { a }, schema: { type: 'object' } };
}

function challenge(pathname, { code = APP_CODE } = {}) {
	const extensions = { bazaar: { info: {} } };
	// `code === null` simulates an endpoint that dropped the declaration entirely.
	if (code !== null) extensions['builder-code'] = builderCodeExtension(code);
	return {
		x402Version: 2,
		error: 'payment required',
		resource: `http://127.0.0.1${pathname}`,
		accepts: [{
			scheme: 'exact',
			network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
			asset: USDC,
			payTo: payToSol,
			amount: AMOUNT,
			extra: { name: 'USDC', decimals: 6, feePayer },
		}],
		extensions,
	};
}

// Per-test knobs.
let perPathCode;   // { [pathStartsWith]: code|null } overrides the declared app code
let settleMode;    // 'ok' | 'reject' | 'echo'
let server;
let origin;

function codeForPath(pathname) {
	for (const [prefix, code] of Object.entries(perPathCode)) {
		if (pathname.startsWith(prefix)) return code;
	}
	return APP_CODE;
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const pathname = req.url.split('?')[0];
		const xPayment = req.headers['x-payment'];

		if (!xPayment) {
			// x402 challenge — advertise the configured builder-code declaration.
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(challenge(pathname, { code: codeForPath(pathname) })));
			return;
		}

		// Paid request — only the dance-tip settlement proof reaches here.
		const payload = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf8'));
		const echoed = payload?.extensions?.['builder-code']?.a;
		if (settleMode === 'reject' || echoed !== APP_CODE) {
			// Mirrors the resource server's anti-tamper rejection.
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ error: 'builder_code_tampered' }));
			return;
		}
		const settled = { success: true, transaction: 'BC_TESTSIG_123', network: payload.network, payer: 'PayerPubkey111' };
		// `echo` mode also reflects the builder-code block back on the response.
		if (settleMode === 'echo') settled.extensions = { 'builder-code': { a: APP_CODE, w: '3d_agent' } };
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json');
		res.setHeader('x-payment-response', Buffer.from(JSON.stringify(settled)).toString('base64'));
		res.end(JSON.stringify({ ok: true, ticketId: 'tkt_bc' }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => { perPathCode = {}; settleMode = 'ok'; process.env.X402_BUILDER_CODE_APP = 'three_d_agent'; });

function makeSqlStub() {
	const calls = [];
	const sql = (strings, ...values) => {
		calls.push({ text: strings.join('?'), values });
		return Promise.resolve([]);
	};
	return { sql, calls };
}

function baseCtx(sqlStub, over = {}) {
	return {
		origin,
		buyer: Keypair.generate(),
		conn: { getAccountInfo: async () => null }, // receiver ATA missing → create ix
		blockhash: '11111111111111111111111111111111',
		mintInfo: { decimals: 6 },
		remainingCap: 5_000_000,
		sql: sqlStub.sql,
		redis: null,
		log: { info() {}, warn() {} },
		runId: '00000000-0000-0000-0000-000000000000',
		...over,
	};
}

describe('builder-code-attribution run()', () => {
	it('verifies every endpoint declares three_d_agent and proves an attributed settlement', async () => {
		const sqlStub = makeSqlStub();
		const out = await run(baseCtx(sqlStub));

		expect(out.success).toBe(true);
		expect(out.errorMsg).toBeNull();
		expect(out.signalData.attribution_ok).toBe(true);
		expect(out.signalData.gaps).toBe(0);
		expect(out.signalData.settle_proven).toBe(true);
		expect(out.amountAtomic).toBe(Number(AMOUNT));
		expect(out.txSig).toBe('BC_TESTSIG_123');
		// Every probed endpoint matched and was persisted to builder_code_attribution.
		const upserts = sqlStub.calls.filter((c) => /insert into\s+builder_code_attribution/i.test(c.text));
		expect(upserts.length).toBe(out.signalData.endpoints_probed);
		expect(sqlStub.calls.some((c) => c.values.includes('BC_TESTSIG_123'))).toBe(true);
	});

	it('flags an attribution gap when an endpoint drops the builder-code declaration', async () => {
		perPathCode = { '/api/x402/crypto-intel': null };
		const sqlStub = makeSqlStub();
		const out = await run(baseCtx(sqlStub));

		expect(out.success).toBe(false);
		expect(out.signalData.attribution_ok).toBe(false);
		expect(out.signalData.gaps).toBe(1);
		expect(out.signalData.gap_endpoints).toContain('/api/x402/crypto-intel');
		expect(out.errorMsg).toMatch(/attribution_gap/);
	});

	it('flags a gap when an endpoint declares the wrong app code', async () => {
		perPathCode = { '/api/x402/fact-check': 'someone_else' };
		const sqlStub = makeSqlStub();
		const out = await run(baseCtx(sqlStub));

		expect(out.success).toBe(false);
		expect(out.signalData.gaps).toBe(1);
		expect(out.signalData.gap_endpoints).toContain('/api/x402/fact-check');
	});

	it('fails the proof (not a gap) when the attributed payment is rejected', async () => {
		settleMode = 'reject';
		const sqlStub = makeSqlStub();
		const out = await run(baseCtx(sqlStub));

		expect(out.signalData.attribution_ok).toBe(true); // declarations all present
		expect(out.signalData.settle_proven).toBe(false);
		expect(out.success).toBe(false);
		expect(out.errorMsg).toMatch(/attributed_settle_failed/);
		expect(out.amountAtomic).toBe(0); // nothing settled
	});

	it('records when the X-PAYMENT-RESPONSE echoes the builder-code block', async () => {
		settleMode = 'echo';
		const sqlStub = makeSqlStub();
		const out = await run(baseCtx(sqlStub));

		expect(out.success).toBe(true);
		expect(out.signalData.response_attributed).toBe(true);
	});

	it('skips entirely (no spend) when X402_BUILDER_CODE_APP is unset', async () => {
		process.env.X402_BUILDER_CODE_APP = '';
		const sqlStub = makeSqlStub();
		const out = await run(baseCtx(sqlStub));

		expect(out.skipped).toBe(true);
		expect(out.success).toBe(false);
		expect(out.errorMsg).toBe('builder_code_app_unset');
		expect(out.amountAtomic).toBe(0);
		// Nothing probed, nothing persisted.
		expect(sqlStub.calls.length).toBe(0);
	});

	it('does not crash when DB persistence fails (the sweep still returns its verdict)', async () => {
		const sql = () => Promise.reject(new Error('db down'));
		const out = await run(baseCtx({ sql, calls: [] }));
		// Persistence failure is swallowed; the attribution verdict is still produced.
		expect(out.signalData.attribution_ok).toBe(true);
		expect(out.success).toBe(true);
	});
});
