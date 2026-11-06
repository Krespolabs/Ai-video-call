import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Mocks ─────────────────────────────────────────────────────────────────

const authState = { session: null, bearer: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

const sqlState = { queue: [], calls: [] };

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: rlState.success })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
}));

const notifyState = { calls: [] };
vi.mock('../../api/_lib/notify.js', () => ({
	insertNotification: vi.fn(async (...a) => {
		notifyState.calls.push(a);
	}),
}));

const confirmState = { result: { status: 'confirmed' }, throws: null, calls: [] };
vi.mock('../../api/_lib/purchase-confirm.js', () => ({
	confirmSkillPurchase: vi.fn(async (...a) => {
		confirmState.calls.push(a);
		if (confirmState.throws) throw confirmState.throws;
		return confirmState.result;
	}),
}));

const mintState = {
	calls: [],
	result: {
		mint: 'MINTpubkey1111111111111111111111111111111111',
		signature: 'SIGsignature11111111111111111111111111111111111111111111111',
		collection: 'COLLmint111111111111111111111111111111111111',
		network: 'mainnet',
		uri: 'https://three.ws/api/agents/solana/skill-nft-metadata?agent=a&skill=s',
		explorer: 'https://solscan.io/token/MINTpubkey',
	},
	throws: null,
};
vi.mock('../../api/_lib/skill-nft.js', () => ({
	mintSkillNft: vi.fn(async (...a) => {
		mintState.calls.push(a);
		if (mintState.throws) throw mintState.throws;
		return mintState.result;
	}),
}));

const { default: handler } = await import('../../api/skills/mint.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

const AGENT = '11111111-1111-1111-1111-111111111111';
const WALLET = 'So11111111111111111111111111111111111111112';
const SIG = 'TXsig1111111111111111111111111111111111111111111111111111111111';

function makeReq({ body } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = 'POST';
	base.url = '/api/skills/mint';
	base.headers = { host: 'localhost', 'content-type': 'application/json' };
	return base;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(body) {
	const req = makeReq({ body });
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function purchase(over = {}) {
	return {
		id: 'pur-1',
		user_id: 'user-1',
		agent_id: AGENT,
		skill: 'translate',
		status: 'confirmed',
		amount: '1000000',
		currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		chain: 'solana',
		tx_signature: SIG,
		skill_nft_mint: null,
		skill_nft_signature: null,
		skill_nft_network: null,
		...over,
	};
}

beforeEach(() => {
	authState.session = { id: 'user-1' };
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
	notifyState.calls = [];
	confirmState.result = { status: 'confirmed' };
	confirmState.throws = null;
	confirmState.calls = [];
	mintState.calls = [];
	mintState.throws = null;
});

const body = (over = {}) => ({
	agent_id: AGENT,
	skill_name: 'translate',
	user_wallet: WALLET,
	...over,
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/skills/mint', () => {
	it('401 when not authenticated', async () => {
		authState.session = null;
		const { status } = await invoke(body());
		expect(status).toBe(401);
		expect(mintState.calls).toHaveLength(0);
	});

	it('400 on invalid agent_id', async () => {
		const { status, body: b } = await invoke(body({ agent_id: 'not-a-uuid' }));
		expect(status).toBe(400);
		expect(b.error).toBe('validation_error');
	});

	it('400 when skill name missing', async () => {
		const { status } = await invoke({ agent_id: AGENT, user_wallet: WALLET });
		expect(status).toBe(400);
	});

	it('403 when recipient wallet is not linked to the user', async () => {
		sqlState.queue = [[]]; // wallet lookup → none
		const { status, body: b } = await invoke(body());
		expect(status).toBe(403);
		expect(b.error).toBe('wallet_not_linked');
		expect(mintState.calls).toHaveLength(0);
	});

	it('404 when no purchase exists', async () => {
		sqlState.queue = [[{ id: 'w' }], []]; // wallet ok, purchase none
		const { status, body: b } = await invoke(body());
		expect(status).toBe(404);
		expect(b.error).toBe('no_purchase');
	});

	it('400 when provided signature contradicts the recorded one', async () => {
		// txSig lookup misses, fallback returns a row carrying a different sig.
		sqlState.queue = [
			[{ id: 'w' }],
			[], // tx_signature-scoped lookup
			[purchase({ tx_signature: 'OTHERsig1111111111111111111111111111111111111111111111111111' })],
		];
		const { status, body: b } = await invoke(body({ transaction_signature: SIG }));
		expect(status).toBe(400);
		expect(b.error).toBe('signature_mismatch');
		expect(mintState.calls).toHaveLength(0);
	});

	it('mints when the purchase is already confirmed', async () => {
		sqlState.queue = [
			[{ id: 'w' }], // wallet
			[purchase()], // purchase (confirmed, not yet minted)
			[{ skill_nft_mint: mintState.result.mint }], // UPDATE … RETURNING
		];
		const { status, body: b } = await invoke(body());
		expect(status).toBe(201);
		expect(b.data.nftMint).toBe(mintState.result.mint);
		expect(b.data.collection).toBe(mintState.result.collection);
		expect(b.data.network).toBe('mainnet');
		expect(mintState.calls).toHaveLength(1);
		expect(mintState.calls[0][0]).toMatchObject({
			agentId: AGENT,
			skill: 'translate',
			ownerWallet: WALLET,
		});
		expect(notifyState.calls).toHaveLength(1);
	});

	it('is idempotent — returns the existing mint without re-minting', async () => {
		sqlState.queue = [
			[{ id: 'w' }],
			[purchase({ skill_nft_mint: 'EXISTINGmint', skill_nft_network: 'mainnet' })],
		];
		const { status, body: b } = await invoke(body());
		expect(status).toBe(200);
		expect(b.data.nftMint).toBe('EXISTINGmint');
		expect(b.data.already_minted).toBe(true);
		expect(mintState.calls).toHaveLength(0);
	});

	it('confirms a pending purchase before minting', async () => {
		confirmState.result = { status: 'confirmed', tx_signature: SIG };
		sqlState.queue = [
			[{ id: 'w' }], // wallet
			[purchase({ status: 'pending', tx_signature: null })], // pending purchase
			[purchase({ status: 'confirmed' })], // re-read after confirm
			[{ skill_nft_mint: mintState.result.mint }], // UPDATE … RETURNING
		];
		const { status, body: b } = await invoke(body());
		expect(status).toBe(201);
		expect(confirmState.calls).toHaveLength(1);
		expect(b.data.nftMint).toBe(mintState.result.mint);
	});

	it('402 when payment is still pending after confirm attempt', async () => {
		confirmState.result = { status: 'pending' };
		sqlState.queue = [
			[{ id: 'w' }],
			[purchase({ status: 'pending', tx_signature: null })],
		];
		const { status, body: b } = await invoke(body());
		expect(status).toBe(402);
		expect(b.error).toBe('payment_pending');
		expect(mintState.calls).toHaveLength(0);
	});

	it('surfaces a mint failure as a clean error', async () => {
		mintState.throws = Object.assign(new Error('authority unconfigured'), {
			status: 500,
			code: 'authority_unconfigured',
		});
		sqlState.queue = [[{ id: 'w' }], [purchase()]];
		const { status, body: b } = await invoke(body());
		expect(status).toBe(500);
		expect(b.error).toBe('authority_unconfigured');
	});
});
