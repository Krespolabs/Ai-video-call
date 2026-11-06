import { describe, it, expect, beforeEach, vi } from 'vitest';

// register_agent / identity_check — the on-chain identity MCP tools. We exercise
// the tool handlers directly (importing toolDefs) with the registry + Granite
// layers mocked, so the test asserts orchestration/contract shape without any
// real Solana RPC, watsonx call, or DB.

// ── DB ──────────────────────────────────────────────────────────────────────
const sqlState = { queue: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// ── Rate limits ───────────────────────────────────────────────────────────────
const rl = { success: true, reset: Date.now() + 60000 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		agentRegister: vi.fn(async () => rl),
		identityCheckIp: vi.fn(async () => rl),
		agentDelegate: vi.fn(async () => rl),
	},
	clientIp: vi.fn(() => '203.0.113.1'),
}));

// ── Agent delegate (call_agent, unused here) ──────────────────────────────────
vi.mock('../../api/_lib/agent-delegate.js', () => ({
	runAgentDelegation: vi.fn(async () => ({ response: 'ok' })),
	AgentNotFoundError: class extends Error {},
}));

// ── three-brand (agentHomeUrl) ────────────────────────────────────────────────
vi.mock('../../api/_lib/three-brand.js', () => ({
	agentHomeUrl: (id) => `https://app.test/agent/${id}`,
}));

// ── Solana collection ─────────────────────────────────────────────────────────
const collectionState = { mainnet: null, devnet: null };
vi.mock('../../api/_lib/solana-collection.js', () => ({
	getAgentCollection: vi.fn((net) => collectionState[net] || null),
}));

// ── On-chain deploy / registry ────────────────────────────────────────────────
const chainState = {
	secret: 'AUTHORITY_SECRET',
	deploy: null,
	register: null,
	buildThrows: false,
};
vi.mock('../../api/_lib/onchain-deploy.js', () => ({
	authoritySecret: vi.fn(() => chainState.secret),
	buildAuthorityUmi: vi.fn(() => {
		if (chainState.buildThrows) throw new Error('authority/funder secret is not a valid base58 keypair');
		return { umi: {}, authoritySigner: { publicKey: { toString: () => 'AUTH_PUBKEY' } } };
	}),
	loadCollectionAsset: vi.fn(async () => null),
	deployAgentOnce: vi.fn(async () => chainState.deploy),
	registerAgentOnce: vi.fn(async () => chainState.register),
	explorerUrl: vi.fn((addr, net) => `https://solscan.io/account/${addr}${net === 'devnet' ? '?cluster=devnet' : ''}`),
}));

// ── Identity integrity (Granite) ──────────────────────────────────────────────
const identityState = { result: null };
vi.mock('../../api/_lib/identity-integrity.js', () => ({
	checkIdentityIntegrity: vi.fn(async () => identityState.result),
}));

// ── Audit log (attach_avatar_to_agent) ────────────────────────────────────────
const auditLog = vi.fn();
vi.mock('../../api/_lib/audit.js', () => ({
	logAudit: (...args) => auditLog(...args),
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────
const { toolDefs } = await import('../../api/_mcp/tools/agents.js');
const onchain = await import('../../api/_lib/onchain-deploy.js');

const TOOLS = Object.fromEntries(toolDefs.map((t) => [t.name, t]));
const UID = 'user-1';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

function ownerAuth(scope) {
	return { userId: UID, scope: scope ?? 'agents:read agents:write', source: 'oauth' };
}

// Parse a tool result's structuredContent (the contract payload).
function out(result) {
	return result.structuredContent;
}

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	collectionState.mainnet = null;
	collectionState.devnet = null;
	chainState.secret = 'AUTHORITY_SECRET';
	chainState.deploy = null;
	chainState.register = null;
	chainState.buildThrows = false;
	identityState.result = null;
	vi.clearAllMocks();
});

// ── Catalog assembly ──────────────────────────────────────────────────────────
describe('catalog assembly', () => {
	it('exposes register_agent (agents:write) and identity_check (agents:read)', () => {
		expect(TOOLS.register_agent).toBeDefined();
		expect(TOOLS.register_agent.scope).toBe('agents:write');
		expect(TOOLS.identity_check).toBeDefined();
		expect(TOOLS.identity_check.scope).toBe('agents:read');
	});
});

// ── register_agent ────────────────────────────────────────────────────────────
describe('register_agent', () => {
	it('rejects an x402/null-user caller with a designed sign-in state', async () => {
		const res = await TOOLS.register_agent.handler(
			{ agent_id: AGENT_ID, chain: 'solana' },
			{ userId: null, rateKey: 'x402:wallet', scope: '', source: 'x402' },
		);
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('sign_in_required');
		// Never touched the DB or the chain.
		expect(sqlState.calls.length).toBe(0);
		expect(onchain.deployAgentOnce).not.toHaveBeenCalled();
	});

	it('rejects registering another account’s agent (ownership check)', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: 'someone-else', name: 'X', meta: {} }]);
		const res = await TOOLS.register_agent.handler({ agent_id: AGENT_ID }, ownerAuth());
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('forbidden');
		expect(onchain.deployAgentOnce).not.toHaveBeenCalled();
		expect(onchain.registerAgentOnce).not.toHaveBeenCalled();
	});

	it('is idempotent: already-registered agent returns existing identity, no re-mint', async () => {
		sqlState.queue.push([
			{
				id: AGENT_ID,
				user_id: UID,
				name: 'Granite Oracle',
				meta: {
					sol_mint_address: 'ASSET1',
					agent_registry: {
						identity_pda: 'PDA1',
						asset: 'ASSET1',
						registration_uri: 'https://ipfs/reg.json',
						tx_hash: 'SIG1',
					},
				},
			},
		]);
		const res = await TOOLS.register_agent.handler({ agent_id: AGENT_ID, chain: 'solana' }, ownerAuth());
		const o = out(res);
		expect(res.isError).toBeUndefined();
		expect(o.status).toBe('already_registered');
		expect(o.agent_pda).toBe('PDA1');
		expect(o.network).toBe('mainnet');
		expect(onchain.deployAgentOnce).not.toHaveBeenCalled();
		expect(onchain.registerAgentOnce).not.toHaveBeenCalled();
	});

	it('chain:base returns a designed needs_wallet_signature payload (no fabricated tx)', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: UID, name: 'Base Bot', description: 'on base', meta: {} }]);
		const res = await TOOLS.register_agent.handler({ agent_id: AGENT_ID, chain: 'base' }, ownerAuth());
		const o = out(res);
		expect(res.isError).toBeUndefined();
		expect(o.status).toBe('needs_wallet_signature');
		expect(o.chain).toBe('base');
		expect(o.chain_id).toBe(8453);
		expect(o.continue_url).toBe(`https://app.test/agent/${AGENT_ID}?deploy=base`);
		// Prepared ERC-8004 registration JSON, fully formed.
		expect(o.registration_json.name).toBe('Base Bot');
		expect(o.registration_json.type).toMatch(/eip-8004/);
		expect(o.registration_json.registrations[0].agentRegistry).toMatch(/^eip155:8453:/);
		// No on-chain side effects.
		expect(onchain.deployAgentOnce).not.toHaveBeenCalled();
	});

	it('returns a designed not-configured error when the Solana authority is unset', async () => {
		chainState.secret = null;
		sqlState.queue.push([{ id: AGENT_ID, user_id: UID, name: 'Solo', meta: {} }]);
		const res = await TOOLS.register_agent.handler({ agent_id: AGENT_ID, chain: 'solana' }, ownerAuth());
		const o = out(res);
		expect(res.isError).toBe(true);
		expect(o.status).toBe('registration_not_configured');
		// Crucially, no fabricated PDA.
		expect(o.agent_pda).toBeUndefined();
		expect(onchain.deployAgentOnce).not.toHaveBeenCalled();
	});

	it('mints + registers a fresh agent on Solana and returns the real PDA', async () => {
		chainState.deploy = {
			asset: 'ASSETX',
			registry: {
				asset: 'ASSETX',
				identityPda: 'PDAX',
				registrationUri: 'https://ipfs/regx.json',
				signature: 'SIGX',
				alreadyRegistered: false,
			},
		};
		sqlState.queue.push([{ id: AGENT_ID, user_id: UID, name: 'Fresh', description: 'new', meta: {} }]);
		const res = await TOOLS.register_agent.handler({ agent_id: AGENT_ID, chain: 'solana' }, ownerAuth());
		const o = out(res);
		expect(res.isError).toBeUndefined();
		expect(o.status).toBe('registered');
		expect(o.agent_pda).toBe('PDAX');
		expect(o.asset).toBe('ASSETX');
		expect(o.registration_uri).toBe('https://ipfs/regx.json');
		expect(o.tx_hash).toBe('SIGX');
		expect(o.explorer_url).toContain('PDAX');
		expect(onchain.deployAgentOnce).toHaveBeenCalledOnce();
		expect(onchain.registerAgentOnce).not.toHaveBeenCalled();
	});

	it('enrols an already-minted (but unregistered) agent without re-minting', async () => {
		chainState.register = {
			asset: 'ASSETM',
			identityPda: 'PDAM',
			registrationUri: 'https://ipfs/regm.json',
			signature: 'SIGM',
			alreadyRegistered: false,
		};
		sqlState.queue.push([
			{ id: AGENT_ID, user_id: UID, name: 'Minted', meta: { sol_mint_address: 'ASSETM' } },
		]);
		const res = await TOOLS.register_agent.handler({ agent_id: AGENT_ID, chain: 'solana' }, ownerAuth());
		const o = out(res);
		expect(o.status).toBe('registered');
		expect(o.agent_pda).toBe('PDAM');
		expect(onchain.deployAgentOnce).not.toHaveBeenCalled();
		expect(onchain.registerAgentOnce).toHaveBeenCalledOnce();
	});

	it('rejects a non-uuid agent_id with a validation error', async () => {
		const res = await TOOLS.register_agent.handler({ agent_id: 'not-a-uuid' }, ownerAuth());
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('validation_error');
	});
});

// ── identity_check ────────────────────────────────────────────────────────────
describe('identity_check', () => {
	it('returns a block verdict with similar agents and reasons (name + description)', async () => {
		identityState.result = {
			configured: true,
			status: 'block',
			uniqueness: 0.02,
			reasons: ['This identity is 98% similar to an existing public agent ("Granite Oracle").'],
			similar: [{ id: 'a2', name: 'Granite Oracle', score: 0.98, owned: false, public: true }],
			duplicateOf: { id: 'a2', name: 'Granite Oracle', score: 0.98 },
			guardian: null,
			model: { embed: 'granite-embed', guardian: null },
		};
		const res = await TOOLS.identity_check.handler(
			{ name: 'The Granite Oracle 🔮', description: 'A wise on-chain oracle.' },
			ownerAuth(),
		);
		const o = out(res);
		expect(o.verdict).toBe('block');
		expect(o.similar_agents).toHaveLength(1);
		expect(o.similar_agents[0].name).toBe('Granite Oracle');
		expect(o.reasons[0]).toMatch(/similar/);
		expect(o.duplicate_of.id).toBe('a2');
	});

	it('screens an existing agent by id (resolves its stored identity)', async () => {
		sqlState.queue.push([
			{ id: AGENT_ID, name: 'My Agent', description: 'mine', persona_tone_tags: ['calm'], user_id: UID, is_public: false },
		]);
		identityState.result = {
			configured: true,
			status: 'clear',
			uniqueness: 0.6,
			reasons: ['Identity is distinct.'],
			similar: [],
			duplicateOf: null,
			guardian: null,
			model: { embed: 'granite-embed', guardian: null },
		};
		const res = await TOOLS.identity_check.handler({ agent_id: AGENT_ID }, ownerAuth());
		const o = out(res);
		expect(o.verdict).toBe('clear');
		expect(o.agent_id).toBe(AGENT_ID);
	});

	it('rejects screening another account’s private agent', async () => {
		sqlState.queue.push([
			{ id: AGENT_ID, name: 'Secret', description: 'hidden', persona_tone_tags: [], user_id: 'other', is_public: false },
		]);
		const res = await TOOLS.identity_check.handler({ agent_id: AGENT_ID }, ownerAuth());
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('forbidden');
	});

	it('requires a name/description or agent_id', async () => {
		const res = await TOOLS.identity_check.handler({}, ownerAuth());
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('validation_error');
	});
});

// ── attach_avatar_to_agent ──────────────────────────────────────────────────────
describe('attach_avatar_to_agent', () => {
	const AVATAR_ID = '33333333-3333-4333-8333-333333333333';

	beforeEach(() => {
		auditLog.mockClear();
	});

	it('exposes attach_avatar_to_agent (agents:write)', () => {
		expect(TOOLS.attach_avatar_to_agent).toBeDefined();
		expect(TOOLS.attach_avatar_to_agent.scope).toBe('agents:write');
	});

	it('rejects an x402/null-user caller with a designed sign-in state', async () => {
		const res = await TOOLS.attach_avatar_to_agent.handler(
			{ agent_id: AGENT_ID, avatar_id: AVATAR_ID },
			{ userId: null, rateKey: 'x402:wallet', scope: '', source: 'x402' },
		);
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('sign_in_required');
		expect(sqlState.calls.length).toBe(0);
	});

	it('rejects a non-uuid agent_id / avatar_id with a validation error', async () => {
		const res1 = await TOOLS.attach_avatar_to_agent.handler({ agent_id: 'nope', avatar_id: AVATAR_ID }, ownerAuth());
		expect(res1.isError).toBe(true);
		expect(out(res1).status).toBe('validation_error');

		const res2 = await TOOLS.attach_avatar_to_agent.handler({ agent_id: AGENT_ID, avatar_id: 'nope' }, ownerAuth());
		expect(res2.isError).toBe(true);
		expect(out(res2).status).toBe('validation_error');
	});

	it('rejects attaching to another account’s agent (ownership check)', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: 'someone-else', name: 'X', avatar_id: null }]);
		const res = await TOOLS.attach_avatar_to_agent.handler({ agent_id: AGENT_ID, avatar_id: AVATAR_ID }, ownerAuth());
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('forbidden');
	});

	it('rejects an avatar not owned by the caller (or missing)', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: UID, name: 'Mine', avatar_id: null }]); // agent lookup
		sqlState.queue.push([]); // avatar lookup — none owned
		const res = await TOOLS.attach_avatar_to_agent.handler({ agent_id: AGENT_ID, avatar_id: AVATAR_ID }, ownerAuth());
		expect(res.isError).toBe(true);
		expect(out(res).status).toBe('not_found');
	});

	it('attaches an owned avatar to an owned agent and logs the audit entry', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: UID, name: 'Mine', avatar_id: null }]); // agent lookup
		sqlState.queue.push([{ id: AVATAR_ID, name: 'Robo', storage_key: 'k', visibility: 'private' }]); // avatar lookup
		sqlState.queue.push([{ id: AGENT_ID, name: 'Mine', avatar_id: AVATAR_ID, wallet_address: 'W1', meta: {} }]); // UPDATE ... RETURNING

		const res = await TOOLS.attach_avatar_to_agent.handler({ agent_id: AGENT_ID, avatar_id: AVATAR_ID }, ownerAuth());
		const o = out(res);
		expect(res.isError).toBeUndefined();
		expect(o.status).toBe('attached');
		expect(o.agent_id).toBe(AGENT_ID);
		expect(o.avatar_id).toBe(AVATAR_ID);
		expect(o.avatar_name).toBe('Robo');
		expect(o.already_onchain).toBe(false);
		expect(o.next_steps.some((s) => s.includes('register_agent'))).toBe(true);
		expect(o.next_steps.some((s) => s.includes('anchor_provenance'))).toBe(true);
		expect(auditLog).toHaveBeenCalledOnce();
		expect(auditLog.mock.calls[0][0]).toMatchObject({ userId: UID, action: 'attach_avatar_to_agent', resourceId: AGENT_ID });
	});

	it('reports already_onchain and skips register_agent in next_steps when the agent is already registered', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: UID, name: 'Mine', avatar_id: null }]);
		sqlState.queue.push([{ id: AVATAR_ID, name: 'Robo', storage_key: 'k', visibility: 'private' }]);
		sqlState.queue.push([
			{
				id: AGENT_ID,
				name: 'Mine',
				avatar_id: AVATAR_ID,
				wallet_address: 'W1',
				meta: { agent_registry: { identity_pda: 'PDA1' } },
			},
		]);

		const res = await TOOLS.attach_avatar_to_agent.handler({ agent_id: AGENT_ID, avatar_id: AVATAR_ID }, ownerAuth());
		const o = out(res);
		expect(o.already_onchain).toBe(true);
		expect(o.next_steps.some((s) => s.includes('register_agent'))).toBe(false);
		expect(o.next_steps.some((s) => s.includes('anchor_provenance'))).toBe(true);
	});
});
