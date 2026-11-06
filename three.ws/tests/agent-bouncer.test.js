// Tests for the Solana Agent Bouncer — the Pole Club door check generalized to
// the whole platform's Solana reputation. Covers tier assignment and the
// admit/refuse verdict under a policy, with the reputation/ban/visit reads
// injected so the verdict logic is exercised without a database.

import { describe, it, expect, vi } from 'vitest';

import { tierForSolanaReputation, vetSolanaAgent } from '../api/_lib/trust/solana-bouncer.js';

// Build a reputation snapshot like loadAgentReputation returns.
function snapshot(over = {}) {
	return {
		agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
		name: 'Helios',
		wallet_address: 'THREEsynthetic1111111111111111111111111PayTo',
		deployed_mints: over.deployed_mints ?? 0,
		mints: [],
		payments: {
			confirmed_count: 0,
			confirmed_amount_atomics: '0',
			distinct_payers: 0,
			failed_count: 0,
			failure_rate: 0,
			...(over.payments || {}),
		},
		distributions: { confirmed: 0, failed: 0, success_rate: 0, ...(over.distributions || {}) },
		buybacks: { confirmed: 0, failed: 0, total_burn_atomics: '0', ...(over.buybacks || {}) },
		attestations: {
			feedback_count: 0,
			validation_count: 0,
			latest_attested_at: null,
			...(over.attestations || {}),
		},
		indexed_at: '2026-06-22T00:00:00.000Z',
	};
}

// vetSolanaAgent reads reputation + ban + visits; inject all three.
function harness(over = {}, { ban = null, visits = 0 } = {}) {
	return {
		read: vi.fn(async () => snapshot(over)),
		banCheck: vi.fn(async () => ban),
		visitsCheck: vi.fn(async () => visits),
	};
}

describe('tierForSolanaReputation', () => {
	it('is a newcomer with no history anywhere', () => {
		expect(tierForSolanaReputation(snapshot(), 0)).toBe('newcomer');
	});

	it('is regular with a little activity', () => {
		expect(tierForSolanaReputation(snapshot({ payments: { confirmed_count: 3, distinct_payers: 2 } }), 0)).toBe(
			'regular',
		);
	});

	it('is trusted with sustained payments from several payers and low failure', () => {
		expect(
			tierForSolanaReputation(
				snapshot({ payments: { confirmed_count: 20, distinct_payers: 5, failure_rate: 0.05 } }),
				0,
			),
		).toBe('trusted');
	});

	it('falls short of trusted when the failure rate is high', () => {
		expect(
			tierForSolanaReputation(
				snapshot({ payments: { confirmed_count: 20, distinct_payers: 5, failure_rate: 0.5 } }),
				0,
			),
		).toBe('regular');
	});

	it('is vip at high volume with validation attestations', () => {
		expect(
			tierForSolanaReputation(
				snapshot({
					payments: { confirmed_count: 80, distinct_payers: 25, failure_rate: 0.02 },
					attestations: { validation_count: 4 },
				}),
				0,
			),
		).toBe('vip');
	});

	it('treats a wallet known only at the Club door as having history (regular, not newcomer)', () => {
		expect(tierForSolanaReputation(snapshot(), 6)).toBe('regular');
	});
});

describe('vetSolanaAgent', () => {
	it('admits an agent that clears the policy', async () => {
		const h = harness({ payments: { confirmed_count: 30, distinct_payers: 8, failure_rate: 0.03 } });
		const v = await vetSolanaAgent({
			agentId: 'x',
			policy: { minPayments: 10, minDistinctPayers: 3, maxFailureRate: 0.2 },
			...h,
		});
		expect(v.admitted).toBe(true);
		expect(v.banned).toBe(false);
		expect(v.tier).toBe('trusted');
		expect(v.reason).toBeNull();
	});

	it('refuses for too few confirmed payments and reports why', async () => {
		const h = harness({ payments: { confirmed_count: 2, distinct_payers: 2 } });
		const v = await vetSolanaAgent({ agentId: 'x', policy: { minPayments: 10 }, ...h });
		expect(v.admitted).toBe(false);
		expect(v.reason).toMatch(/only 2 confirmed payment/);
	});

	it('refuses when the payment failure rate is too high', async () => {
		const h = harness({ payments: { confirmed_count: 10, failed_count: 10, distinct_payers: 4, failure_rate: 0.5 } });
		const v = await vetSolanaAgent({ agentId: 'x', policy: { maxFailureRate: 0.2 }, ...h });
		expect(v.admitted).toBe(false);
		expect(v.reason).toMatch(/failure rate/);
	});

	it('bans a wallet on the Club ban list — folding the Club ledger in', async () => {
		const h = harness(
			{ payments: { confirmed_count: 99, distinct_payers: 40 } },
			{ ban: { wallet: 'w', reason: 'rug puller' } },
		);
		const v = await vetSolanaAgent({ agentId: 'x', ...h });
		expect(v.banned).toBe(true);
		expect(v.admitted).toBe(false);
		expect(v.tier).toBe('banned');
		expect(v.reason).toBe('rug puller');
	});

	it('admits a newcomer by default but refuses when the policy forbids them', async () => {
		const open = await vetSolanaAgent({ agentId: 'x', ...harness() });
		expect(open.newcomer).toBe(true);
		expect(open.tier).toBe('newcomer');
		expect(open.admitted).toBe(true);

		const strict = await vetSolanaAgent({ agentId: 'x', policy: { allowNewcomers: false }, ...harness() });
		expect(strict.admitted).toBe(false);
		expect(strict.reason).toMatch(/newcomers not admitted/);
	});

	it('requires a minimum number of signed Solana attestations when asked', async () => {
		const h = harness({
			payments: { confirmed_count: 50, distinct_payers: 20 },
			attestations: { feedback_count: 1, validation_count: 0 },
		});
		const v = await vetSolanaAgent({ agentId: 'x', policy: { minAttestations: 5 }, ...h });
		expect(v.admitted).toBe(false);
		expect(v.reason).toMatch(/signed attestation/);
	});

	it('surfaces the agent identity and visit count in the verdict', async () => {
		const h = harness({ payments: { confirmed_count: 4 } }, { visits: 7 });
		const v = await vetSolanaAgent({ agentId: 'x', ...h });
		expect(v.agent_id).toBe('7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55');
		expect(v.name).toBe('Helios');
		expect(v.visits).toBe(7);
		expect(v.reputation.payments.confirmed_count).toBe(4);
	});
});
