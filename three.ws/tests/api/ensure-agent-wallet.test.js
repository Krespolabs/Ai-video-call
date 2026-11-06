// ensureAgentWallet() — the single custodial-wallet invariant.
//
// Verifies it: (1) returns an existing valid wallet without re-provisioning,
// (2) lazily provisions + persists a fresh keypair when the address/secret is
// missing, (3) repairs a row whose address parses but whose secret is gone (and
// vice-versa), (4) never returns or logs the decrypted secret, and (5) audit-logs
// every lazy provision. Real key generation + real PublicKey validation run; only
// the DB and the usage audit sink are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

// Captured UPDATE writes so we can assert what got persisted to meta.
const sqlState = { queue: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const query = typeof strings === 'string' ? strings : strings.join('?');
		sqlState.calls.push({ query, values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { JWT_SECRET: 'test-secret-please-do-not-use-in-production-ever' },
}));

const auditEvents = [];
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn((evt) => auditEvents.push(evt)),
}));

const { ensureAgentWallet } = await import('../../api/_lib/agent-wallet.js');

function updateCalls() {
	return sqlState.calls.filter((c) => /update agent_identities/i.test(c.query));
}

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	auditEvents.length = 0;
});

describe('ensureAgentWallet', () => {
	it('returns the existing wallet without re-provisioning when both fields are valid', async () => {
		const address = Keypair.generate().publicKey.toBase58();
		sqlState.queue.push([
			{ id: 'agent-1', user_id: 'user-1', meta: { solana_address: address, encrypted_solana_secret: 'ZW5j' } },
		]);

		const res = await ensureAgentWallet('agent-1', 'user-1');

		expect(res).toEqual({ address, created: false });
		expect(updateCalls()).toHaveLength(0);
		expect(auditEvents).toHaveLength(0);
	});

	it('lazily provisions and persists a fresh wallet when none exists', async () => {
		sqlState.queue.push([{ id: 'agent-2', user_id: 'user-2', meta: {} }]);

		const res = await ensureAgentWallet('agent-2', 'user-2', { reason: 'deposit' });

		expect(res.created).toBe(true);
		// Returned address must be a real, parseable Solana pubkey.
		expect(res.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
		expect(() => new PublicKey(res.address)).not.toThrow();

		const writes = updateCalls();
		expect(writes).toHaveLength(1);
		const persistedMeta = JSON.parse(writes[0].values.find((v) => typeof v === 'string' && v.includes('solana_address')));
		expect(persistedMeta.solana_address).toBe(res.address);
		expect(typeof persistedMeta.encrypted_solana_secret).toBe('string');
		expect(persistedMeta.encrypted_solana_secret.length).toBeGreaterThan(0);
		// Provenance recorded.
		expect(persistedMeta.solana_wallet_source).toBe('lazy_provision');
	});

	it('audit-logs the lazy provision with the public address but never the secret', async () => {
		sqlState.queue.push([{ id: 'agent-3', user_id: 'user-3', meta: {} }]);

		const res = await ensureAgentWallet('agent-3', 'user-3', { reason: 'withdraw' });

		expect(auditEvents).toHaveLength(1);
		const evt = auditEvents[0];
		expect(evt.kind).toBe('solana_wallet_provision');
		expect(evt.tool).toBe('withdraw');
		expect(evt.agentId).toBe('agent-3');
		expect(evt.meta.address).toBe(res.address);
		// The secret must never appear anywhere in the audit payload.
		const serialized = JSON.stringify(evt);
		expect(serialized).not.toMatch(/encrypted_solana_secret/);
	});

	it('repairs a row whose address is present but the secret is missing', async () => {
		const address = Keypair.generate().publicKey.toBase58();
		sqlState.queue.push([{ id: 'agent-4', user_id: 'user-4', meta: { solana_address: address } }]);

		const res = await ensureAgentWallet('agent-4', 'user-4');

		expect(res.created).toBe(true);
		// A new keypair is minted (we can't recover a secret we never had), so the
		// address changes to one we hold the key for.
		expect(res.address).not.toBe(address);
		expect(updateCalls()).toHaveLength(1);
	});

	it('repairs a row whose address fails to parse', async () => {
		sqlState.queue.push([
			{ id: 'agent-5', user_id: 'user-5', meta: { solana_address: 'not-a-real-base58-address!!', encrypted_solana_secret: 'ZW5j' } },
		]);

		const res = await ensureAgentWallet('agent-5', 'user-5');

		expect(res.created).toBe(true);
		expect(res.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
		expect(updateCalls()).toHaveLength(1);
	});

	it('never leaks the decrypted secret in the returned value', async () => {
		sqlState.queue.push([{ id: 'agent-6', user_id: 'user-6', meta: {} }]);
		const res = await ensureAgentWallet('agent-6', 'user-6');
		expect(Object.keys(res).sort()).toEqual(['address', 'created']);
	});

	it('throws a clean error for an unknown agent', async () => {
		sqlState.queue.push([]); // no row
		await expect(ensureAgentWallet('missing', 'user-x')).rejects.toThrow(/agent not found/);
	});

	it('requires an agentId', async () => {
		await expect(ensureAgentWallet(null)).rejects.toThrow(/agentId required/);
	});
});
