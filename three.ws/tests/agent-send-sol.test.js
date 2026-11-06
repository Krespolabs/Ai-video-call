// POST /api/agent/send-sol — the avatar's custodial SOL payout endpoint.
//
// This path signs with the avatar's key and moves real SOL, so its guardrails
// are money-safety-critical: per-send USD cap, recipient gating (the drain
// vector), balance headroom, daily payout ceiling, and an immutable audit row
// for every payout. The avatar wallet, RPC, SOL price, and audit sink are all
// mocked so no key is loaded and no chain is hit — we assert the guards reject
// the way they must, that a successful send writes the audit trail, and that
// the custodial secret never appears in any response.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair } from '@solana/web3.js';

const AVATAR_ADDR = Keypair.generate().publicKey.toBase58();
const DEFAULT_RECIPIENT = Keypair.generate().publicKey.toBase58();
const OTHER_RECIPIENT = Keypair.generate().publicKey.toBase58();
const SECRET = 'AVATAR_SECRET::do-not-leak::ZW5jcnlwdGVk';

const LAMPORTS_PER_SOL = 1_000_000_000;

// Tunable wallet config + chain state per test.
const cfgState = {
	configured: true,
	demoToken: null,
	lockRecipient: false,
	defaultRecipient: DEFAULT_RECIPIENT,
	maxSendUsd: 100,
	rpcUrl: 'https://rpc.example',
	address: AVATAR_ADDR,
	network: 'mainnet',
};
const chainState = {
	price: 200, // $/SOL
	balanceLamports: 5 * LAMPORTS_PER_SOL,
	sendSig: 'SIG_PAYOUT_123',
	dailyOk: true,
};

const sendSolSpy = vi.fn(async () => chainState.sendSig);

vi.mock('../api/_lib/avatar-wallet.js', () => ({
	avatarWalletConfig: () => ({ ...cfgState }),
	loadAvatarKeypair: (secret) => {
		// Mirror the real contract: it consumes the secret. We never surface it.
		if (!secret) throw new Error('no secret');
		return Keypair.generate();
	},
	getConnection: () => ({}),
	getSolBalance: async () => ({ lamports: chainState.balanceLamports }),
	solUsdPrice: async () => chainState.price,
	sendSol: sendSolSpy,
	isValidPubkey: (s) => typeof s === 'string' && s.length >= 32 && s.length <= 44,
	explorerTxUrl: (sig, net) => `https://explorer.example/tx/${sig}?cluster=${net}`,
	explorerAccountUrl: (addr, net) => `https://explorer.example/address/${addr}?cluster=${net}`,
	LAMPORTS_PER_SOL,
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		avatarPayoutDaily: vi.fn(async () => ({ success: chainState.dailyOk, reset: Date.now() + 1000 })),
	},
	clientIp: () => '203.0.113.7',
}));

const logAuditSpy = vi.fn();
vi.mock('../api/_lib/audit.js', () => ({ logAudit: logAuditSpy }));

const { default: handler } = await import('../api/agent/send-sol.js');

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq({ body = null, headers = {} } = {}) {
	const chunks = body != null ? [Buffer.from(JSON.stringify(body))] : [];
	const r = Readable.from(chunks);
	r.method = 'POST';
	r.url = '/api/agent/send-sol';
	r.headers = { origin: 'http://localhost:3000', 'content-type': 'application/json', 'user-agent': 'vitest', ...headers };
	return r;
}

async function send(body, headers) {
	const req = mockReq({ body, headers });
	const res = mockRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	cfgState.configured = true;
	cfgState.demoToken = null;
	cfgState.lockRecipient = false;
	cfgState.defaultRecipient = DEFAULT_RECIPIENT;
	cfgState.maxSendUsd = 100;
	chainState.price = 200;
	chainState.balanceLamports = 5 * LAMPORTS_PER_SOL;
	chainState.dailyOk = true;
	sendSolSpy.mockClear();
	logAuditSpy.mockClear();
	process.env.AVATAR_WALLET_SECRET = SECRET;
});

describe('POST /api/agent/send-sol — guards', () => {
	it('503 when the avatar wallet is not configured', async () => {
		cfgState.configured = false;
		const res = await send({ usd: 1 });
		expect(res.statusCode).toBe(503);
		expect(res.json.error).toBe('wallet_unconfigured');
		expect(sendSolSpy).not.toHaveBeenCalled();
	});

	it('400 when neither usd nor sol is provided', async () => {
		const res = await send({ memo: 'hi' });
		expect(res.statusCode).toBe(400);
	});

	it('400 when the amount exceeds the per-send USD cap', async () => {
		const res = await send({ usd: 250 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('amount_too_large');
		expect(sendSolSpy).not.toHaveBeenCalled();
	});

	it('enforces the cap on sol-denominated sends via the live price', async () => {
		// 1 SOL @ $200 = $200 > $100 cap.
		const res = await send({ sol: 1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('amount_too_large');
	});

	it('403 on an arbitrary recipient when no demo token is configured (drain vector)', async () => {
		const res = await send({ usd: 1, to: OTHER_RECIPIENT });
		expect(res.statusCode).toBe(403);
		expect(res.json.error).toBe('recipient_not_allowed');
		expect(sendSolSpy).not.toHaveBeenCalled();
	});

	it('ignores a client-supplied recipient when the wallet is recipient-locked', async () => {
		cfgState.lockRecipient = true;
		const res = await send({ usd: 1, to: OTHER_RECIPIENT });
		expect(res.statusCode).toBe(200);
		expect(res.json.to).toBe(DEFAULT_RECIPIENT);
	});

	it('401 when a demo token is required but the header is missing/wrong', async () => {
		cfgState.demoToken = 'sekret';
		const res = await send({ usd: 1 }, { 'x-avatar-token': 'nope' });
		expect(res.statusCode).toBe(401);
		expect(sendSolSpy).not.toHaveBeenCalled();
	});

	it('409 insufficient_funds before signing when balance cannot cover amount + fee', async () => {
		chainState.balanceLamports = 1000; // far below any send + fee buffer
		const res = await send({ usd: 1 });
		expect(res.statusCode).toBe(409);
		expect(res.json.error).toBe('insufficient_funds');
		expect(sendSolSpy).not.toHaveBeenCalled();
	});

	it('429 when the wallet-wide daily payout ceiling is hit', async () => {
		chainState.dailyOk = false;
		const res = await send({ usd: 1 });
		expect(res.statusCode).toBe(429);
		expect(sendSolSpy).not.toHaveBeenCalled();
	});
});

describe('POST /api/agent/send-sol — successful payout', () => {
	it('signs, returns the confirmed signature, and converts USD→SOL at the live price', async () => {
		const res = await send({ usd: 50 });
		expect(res.statusCode).toBe(200);
		expect(res.json.ok).toBe(true);
		expect(res.json.signature).toBe('SIG_PAYOUT_123');
		expect(res.json.to).toBe(DEFAULT_RECIPIENT);
		expect(res.json.usd).toBe(50);
		expect(res.json.sol).toBeCloseTo(0.25, 6); // $50 / $200
		expect(sendSolSpy).toHaveBeenCalledOnce();
	});

	it('writes an immutable audit row for the payout with amount + signature', async () => {
		await send({ usd: 50, memo: 'gm' });
		expect(logAuditSpy).toHaveBeenCalledOnce();
		const entry = logAuditSpy.mock.calls[0][0];
		expect(entry.action).toBe('avatar_payout');
		expect(entry.resourceId).toBe('SIG_PAYOUT_123');
		expect(entry.meta).toMatchObject({
			from: AVATAR_ADDR,
			to: DEFAULT_RECIPIENT,
			usd: 50,
			network: 'mainnet',
		});
		expect(entry.meta.lamports).toBeGreaterThan(0);
	});

	it('does NOT write an audit row when a guard rejects the request', async () => {
		await send({ usd: 250 }); // over cap
		expect(logAuditSpy).not.toHaveBeenCalled();
	});

	it('never leaks the custodial secret in the response body', async () => {
		const res = await send({ usd: 10 });
		expect(res._body).not.toContain(SECRET);
		expect(res._body).not.toContain('do-not-leak');
	});
});
