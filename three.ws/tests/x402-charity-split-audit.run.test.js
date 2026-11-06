import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import {
	Keypair,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// End-to-end orchestration test of the Charity Split Audit run(): the free
// merchant-config sweep, the real production-checkout canary (prepare → sign →
// encode → settle), and the on-chain verification of the charity leg — all
// driven against a mock checkout/dance-tip server with the DB and the chain read
// stubbed at their boundaries. No external services, no on-chain spend; the
// transaction is really built and signed locally, exactly like circuit-breaker's
// test, so this exercises the true code path end to end.

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const buyer = Keypair.generate();
const payTo = Keypair.generate().publicKey;
const feePayer = Keypair.generate().publicKey;
const BASE = '1000'; // $0.001 USDC atomics
const BPS = 500; // 5% → split = 50
const SPLIT = 50;
process.env.X402_CHARITY_AUDIT_BPS = String(BPS);
// Canary cause wallet = the buyer (default self-route); split lands on buyer ATA.
const charityAta = getAssociatedTokenAddressSync(new PublicKey(USDC), buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
const payToAta = getAssociatedTokenAddressSync(new PublicKey(USDC), payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();

const DUMMY_BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const SETTLED_SIG = '5'.repeat(64);

// ── Stub the DB at its boundary. Route by SQL text; record the audit rows. ──
const auditRows = [];
const logRows = [];
let merchantRows = [];
function fakeSql(strings, ...vals) {
	const text = strings.join(' ');
	if (text.includes('from x402_merchant_settings')) return Promise.resolve(merchantRows);
	if (text.includes('INSERT INTO charity_split_audit')) {
		// Column order mirrors recordAuditRow's VALUES list.
		auditRows.push({ merchant_id: vals[1], kind: vals[2], config_valid: vals[8], broken_reason: vals[9], expected_split: vals[11], routed_split: vals[12], charity_routed: vals[13], tx: vals[14] });
		return Promise.resolve([]);
	}
	if (text.includes('INSERT INTO x402_autonomous_log')) {
		logRows.push({ service: vals[2], amount_atomic: vals[5], tx: vals[7], value_extracted: vals[9], success: vals[11], error: vals[12] });
		return Promise.resolve([]);
	}
	return Promise.resolve([]); // CREATE TABLE / ALTER / INDEX
}
vi.mock('../api/_lib/db.js', () => ({ sql: (s, ...v) => fakeSql(s, ...v), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// ── Mock checkout + dance-tip endpoints ──────────────────────────────────────
function solanaAccept() {
	return { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC, payTo: payTo.toBase58(), amount: BASE, maxTimeoutSeconds: 60, extra: { name: 'USDC', decimals: 6, feePayer: feePayer.toBase58() } };
}

// Build a real, signable v0 tx with the base + charity transfer legs — what the
// production /api/x402-checkout prepare returns. buyer is the transfer authority,
// so the pipeline's vtx.sign([buyer]) succeeds.
function buildPreparedTx(tips) {
	const mint = new PublicKey(USDC);
	const senderAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
	const ixs = [
		createTransferCheckedInstruction(senderAta, mint, getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), buyer.publicKey, BigInt(BASE), 6, [], TOKEN_PROGRAM_ID),
	];
	for (const t of tips || []) {
		ixs.push(createTransferCheckedInstruction(senderAta, mint, getAssociatedTokenAddressSync(mint, new PublicKey(t.to), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), buyer.publicKey, BigInt(t.amount), 6, [], TOKEN_PROGRAM_ID));
	}
	const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: DUMMY_BLOCKHASH, instructions: ixs }).compileToV0Message();
	return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

let server, origin;
beforeAll(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const send = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
			// dance-tip: 402 challenge, or 200 settled when carrying X-PAYMENT.
			if (url.pathname === '/api/x402/dance-tip') {
				if (req.headers['x-payment']) {
					const xpr = Buffer.from(JSON.stringify({ transaction: SETTLED_SIG })).toString('base64');
					return send(200, { ok: true, ticketId: 't1' }, { 'x-payment-response': xpr });
				}
				return send(402, { accepts: [solanaAccept()] });
			}
			// checkout prepare / encode.
			if (url.pathname === '/api/x402-checkout') {
				const action = url.searchParams.get('action');
				const parsed = body ? JSON.parse(body) : {};
				if (action === 'prepare') return send(200, { network: 'solana', tx_base64: buildPreparedTx(parsed.tips), recent_blockhash: DUMMY_BLOCKHASH });
				if (action === 'encode') return send(200, { x_payment: Buffer.from('paymentpayload').toString('base64') });
			}
			send(404, { error: 'not_found' });
		});
	});
	await new Promise((r) => server.listen(0, r));
	origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

// Fake Solana connection — only getParsedTransaction is used (ctx.conn supplied,
// so bootstrap is skipped). Return the settled tx with both transfer legs.
const fakeConn = {
	getParsedTransaction: async () => ({
		transaction: { message: { instructions: [
			{ program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: payToAta, tokenAmount: { amount: BASE } } } },
			{ program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: charityAta, tokenAmount: { amount: String(SPLIT) } } } },
		] } },
		meta: { innerInstructions: [], err: null },
	}),
};

const { run } = await import('../api/_lib/x402/pipelines/charity-split-audit.js');

describe('charity-split-audit run() — full orchestration', () => {
	it('sweeps configs, settles the canary, verifies the charity leg on-chain, and logs', async () => {
		auditRows.length = 0; logRows.length = 0;
		merchantRows = [
			{ owner_user_id: 'good', charity_name: 'Good Cause', charity_chain: 'solana', charity_address: Keypair.generate().publicKey.toBase58(), charity_bps: 250, payout_solana: Keypair.generate().publicKey.toBase58(), payout_evm: null },
			{ owner_user_id: 'broken', charity_name: 'Oops', charity_chain: 'solana', charity_address: null, charity_bps: 300, payout_solana: Keypair.generate().publicKey.toBase58(), payout_evm: null },
		];

		const out = await run({ origin, buyer, conn: fakeConn, remainingCap: 1_000_000, runId: '00000000-0000-0000-0000-000000000001' });

		// Loop-facing contract.
		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(Number(BASE) + SPLIT); // base + split billed to the cap
		expect(out.txSig).toBe(SETTLED_SIG);
		expect(out.merchantsAudited).toBe(2);
		expect(out.brokenCount).toBe(1);
		expect(out.canary.charityRouted).toBe(true);
		expect(out.signalData.canary_charity_routed).toBe(true);

		// A log row was written (the pipeline's own summary) — DoD: "verify log row created".
		expect(logRows.length).toBe(1);
		expect(logRows[0].service).toBe('Charity Split Audit');
		expect(logRows[0].success).toBe(true);
		const ve = JSON.parse(logRows[0].value_extracted);
		expect(ve.merchants_audited).toBe(2);
		expect(ve.broken_count).toBe(1);
		expect(ve.canary.split_atomic).toBe(SPLIT);
		expect(ve.canary.charity_routed).toBe(true);

		// Per-merchant + canary rows stored to charity_split_audit — DoD: "data stored".
		const good = auditRows.find((r) => r.merchant_id === 'good');
		const broken = auditRows.find((r) => r.merchant_id === 'broken');
		const canary = auditRows.find((r) => r.merchant_id === 'canary');
		expect(good.config_valid).toBe(true);
		expect(good.expected_split).toBe(25_000); // $1.00 @ 2.5%
		expect(broken.config_valid).toBe(false);
		expect(broken.broken_reason).toBe('missing_charity_address');
		expect(canary.kind).toBe('canary');
		expect(canary.charity_routed).toBe(true);
		expect(canary.routed_split).toBe(SPLIT);
		expect(canary.tx).toBe(SETTLED_SIG);
	});

	it('flags an unrouted charity leg when the split never lands on-chain', async () => {
		auditRows.length = 0; logRows.length = 0;
		merchantRows = [];
		const noLegConn = {
			getParsedTransaction: async () => ({
				transaction: { message: { instructions: [
					{ program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: payToAta, tokenAmount: { amount: BASE } } } },
				] } },
				meta: { innerInstructions: [], err: null },
			}),
		};
		const out = await run({ origin, buyer, conn: noLegConn, remainingCap: 1_000_000 });
		expect(out.canary.charityRouted).toBe(false);
		expect(out.success).toBe(false); // a dropped donation is the alert signal
		expect(out.errorMsg).toBe('canary_charity_not_routed');
		expect(logRows[0].success).toBe(false);
	});

	it('still settles + still records a log row when the wallet is unconfigured (no canary)', async () => {
		auditRows.length = 0; logRows.length = 0;
		merchantRows = [];
		// No ctx.buyer and no seed env → canary skips; the sweep + log row still run.
		const prev = process.env.X402_SEED_SOLANA_SECRET_BASE58;
		const prevAgent = process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		const prevNodeEnv = process.env.NODE_ENV;
		delete process.env.X402_SEED_SOLANA_SECRET_BASE58;
		delete process.env.X402_AGENT_SOLANA_SECRET_BASE58;
		process.env.NODE_ENV = 'production'; // block the local test-wallet fallback
		try {
			const out = await run({ origin, conn: fakeConn, remainingCap: 1_000_000 });
			expect(out.amountAtomic).toBe(0);
			expect(out.canary.attempted).toBe(false);
			expect(logRows.length).toBe(1); // log row always written
		} finally {
			if (prev) process.env.X402_SEED_SOLANA_SECRET_BASE58 = prev;
			if (prevAgent) process.env.X402_AGENT_SOLANA_SECRET_BASE58 = prevAgent;
			process.env.NODE_ENV = prevNodeEnv;
		}
	});
});
