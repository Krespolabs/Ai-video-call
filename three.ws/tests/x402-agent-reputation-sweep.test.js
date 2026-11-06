import { describe, it, expect } from 'vitest';
import {
	scoreAgentReputation,
	sweepAgentReputation,
	REPUTATION_FLAG_THRESHOLD,
} from '../api/_lib/trust/solana-bouncer.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const rep = (over = {}) => ({
	agent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
	name: 'TestAgent',
	wallet_address: 'THREEsynthetic1111111111111111111111111111',
	deployed_mints: 1,
	payments: {
		confirmed_count: 0,
		confirmed_amount_atomics: '0',
		distinct_payers: 0,
		failed_count: 0,
		failure_rate: 0,
	},
	distributions: { confirmed: 0, failed: 0, success_rate: 0 },
	buybacks: { confirmed: 0, failed: 0, total_burn_atomics: '0' },
	attestations: { feedback_count: 0, validation_count: 0, latest_attested_at: null },
	indexed_at: new Date().toISOString(),
	...over,
});

const withPayments = (confirmed, payers, failureRate = 0) =>
	rep({
		payments: {
			confirmed_count: confirmed,
			confirmed_amount_atomics: String(confirmed * 1_000_000),
			distinct_payers: payers,
			failed_count: Math.round((confirmed / (1 - failureRate || 1)) * failureRate),
			failure_rate: failureRate,
		},
	});

// ── scoreAgentReputation ─────────────────────────────────────────────────────

describe('scoreAgentReputation — zero activity', () => {
	it('scores 0 for a brand-new agent with no history', () => {
		const { score, flagged } = scoreAgentReputation(rep());
		expect(score).toBe(0);
		expect(flagged).toBe(true);
	});

	it('flags when score < REPUTATION_FLAG_THRESHOLD', () => {
		expect(REPUTATION_FLAG_THRESHOLD).toBe(30);
		const { flagged } = scoreAgentReputation(rep());
		expect(flagged).toBe(true);
	});

	it('returns reasons for a zero-activity agent', () => {
		const { reasons } = scoreAgentReputation(rep());
		expect(reasons.length).toBeGreaterThan(0);
		expect(reasons.some((r) => /payment/i.test(r))).toBe(true);
	});
});

describe('scoreAgentReputation — payment volume', () => {
	it('scores higher with more confirmed payments', () => {
		const low = scoreAgentReputation(withPayments(5, 2)).score;
		const high = scoreAgentReputation(withPayments(40, 8)).score;
		expect(high).toBeGreaterThan(low);
	});

	it('max payments (50+) + 10 payers fills the payment bucket', () => {
		const { breakdown } = scoreAgentReputation(withPayments(50, 10));
		expect(breakdown.payments).toBe(45);
	});

	it('elevated failure rate shows in reasons', () => {
		const { reasons } = scoreAgentReputation(
			rep({
				payments: {
					confirmed_count: 30,
					confirmed_amount_atomics: '30000000',
					distinct_payers: 5,
					failed_count: 10,
					failure_rate: 0.25,
				},
			}),
		);
		expect(reasons.some((r) => /failure rate/i.test(r))).toBe(true);
	});
});

describe('scoreAgentReputation — distributions and buybacks', () => {
	it('credits a perfect distribution record', () => {
		const noDistrib = scoreAgentReputation(withPayments(20, 5)).score;
		const withDistrib = scoreAgentReputation({
			...withPayments(20, 5),
			distributions: { confirmed: 5, failed: 0, success_rate: 1.0 },
		}).score;
		expect(withDistrib).toBeGreaterThan(noDistrib);
	});

	it('flags low distribution success rate in reasons', () => {
		const { reasons } = scoreAgentReputation({
			...rep(),
			distributions: { confirmed: 1, failed: 3, success_rate: 0.25 },
		});
		expect(reasons.some((r) => /distribution/i.test(r))).toBe(true);
	});
});

describe('scoreAgentReputation — attestations', () => {
	it('adds attestation points up to the bucket max', () => {
		const noAtt = scoreAgentReputation(rep()).score;
		const withAtt = scoreAgentReputation({
			...rep(),
			attestations: { feedback_count: 10, validation_count: 0, latest_attested_at: null },
		}).score;
		expect(withAtt).toBeGreaterThan(noAtt);
	});

	it('caps attestation contribution at 10 total attestations', () => {
		const a = scoreAgentReputation({
			...rep(),
			attestations: { feedback_count: 10, validation_count: 0, latest_attested_at: null },
		}).breakdown.attestations;
		const b = scoreAgentReputation({
			...rep(),
			attestations: { feedback_count: 50, validation_count: 0, latest_attested_at: null },
		}).breakdown.attestations;
		expect(a).toBe(b);
	});
});

describe('scoreAgentReputation — high-trust agent', () => {
	it('a well-established agent clears the flag threshold', () => {
		const { score, flagged } = scoreAgentReputation({
			...rep(),
			deployed_mints: 2,
			payments: {
				confirmed_count: 50,
				confirmed_amount_atomics: '50000000',
				distinct_payers: 10,
				failed_count: 2,
				failure_rate: 0.04,
			},
			distributions: { confirmed: 8, failed: 0, success_rate: 1.0 },
			buybacks: { confirmed: 3, failed: 0, total_burn_atomics: '300000000' },
			attestations: { feedback_count: 8, validation_count: 2, latest_attested_at: null },
		});
		expect(score).toBeGreaterThanOrEqual(REPUTATION_FLAG_THRESHOLD);
		expect(flagged).toBe(false);
	});
});

describe('scoreAgentReputation — breakdown keys', () => {
	it('always returns a breakdown object with the four keys', () => {
		const { breakdown } = scoreAgentReputation(rep());
		expect(breakdown).toHaveProperty('payments');
		expect(breakdown).toHaveProperty('distributions');
		expect(breakdown).toHaveProperty('buybacks');
		expect(breakdown).toHaveProperty('attestations');
	});
});

// ── sweepAgentReputation ─────────────────────────────────────────────────────

const agentRow = (id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') => ({
	id,
	name: 'TestAgent',
	wallet_address: 'THREEsynthetic1111111111111111111111111111',
	last_active_at: new Date().toISOString(),
});

describe('sweepAgentReputation — aggregate output', () => {
	it('returns the correct shape', async () => {
		const fakeRep = rep({
			payments: { confirmed_count: 25, confirmed_amount_atomics: '25000000', distinct_payers: 5, failed_count: 0, failure_rate: 0 },
		});
		const result = await sweepAgentReputation({
			limit: 2,
			list: async () => [agentRow('aaaa0000-0000-0000-0000-000000000001'), agentRow('aaaa0000-0000-0000-0000-000000000002')],
			read: async () => fakeRep,
		});
		expect(result.mode).toBe('sweep');
		expect(result.count).toBe(2);
		expect(typeof result.avg_score).toBe('number');
		expect(typeof result.flagged_count).toBe('number');
		expect(Array.isArray(result.flagged)).toBe(true);
		expect(Array.isArray(result.agents)).toBe(true);
		expect(result.agents).toHaveLength(2);
		expect(typeof result.swept_at).toBe('string');
	});

	it('avg_score is 0 when the list is empty', async () => {
		const result = await sweepAgentReputation({
			limit: 5,
			list: async () => [],
			read: async () => rep(),
		});
		expect(result.count).toBe(0);
		expect(result.avg_score).toBe(0);
		expect(result.flagged_count).toBe(0);
	});

	it('avg_score matches the mean of per-agent scores', async () => {
		const makeRep = (confirmed) =>
			rep({
				payments: {
					confirmed_count: confirmed,
					confirmed_amount_atomics: String(confirmed * 1_000_000),
					distinct_payers: Math.min(confirmed, 5),
					failed_count: 0,
					failure_rate: 0,
				},
			});
		const scores = [0, 25, 50].map((c) => scoreAgentReputation(makeRep(c)).score);
		const expected = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

		let callIdx = 0;
		const confirmeds = [0, 25, 50];
		const result = await sweepAgentReputation({
			limit: 3,
			list: async () => confirmeds.map((_, i) => agentRow(`aaaa0000-0000-0000-0000-${String(i).padStart(12, '0')}`)),
			read: async () => makeRep(confirmeds[callIdx++]),
		});
		expect(result.avg_score).toBe(expected);
	});

	it('flagged list only contains agents with score < REPUTATION_FLAG_THRESHOLD', async () => {
		let calls = 0;
		const result = await sweepAgentReputation({
			limit: 2,
			list: async () => [
				agentRow('aaaa0000-0000-0000-0000-000000000001'),
				agentRow('aaaa0000-0000-0000-0000-000000000002'),
			],
			read: async () => {
				calls++;
				if (calls === 1) return rep(); // score 0 — should be flagged
				// a well-established agent — should not be flagged
				return rep({
					payments: { confirmed_count: 50, confirmed_amount_atomics: '50000000', distinct_payers: 10, failed_count: 0, failure_rate: 0 },
					distributions: { confirmed: 5, failed: 0, success_rate: 1 },
					buybacks: { confirmed: 2, failed: 0, total_burn_atomics: '200000000' },
					attestations: { feedback_count: 8, validation_count: 2, latest_attested_at: null },
				});
			},
		});
		expect(result.flagged_count).toBe(1);
		expect(result.flagged[0].score).toBeLessThan(REPUTATION_FLAG_THRESHOLD);
	});

	it('respects the limit (clamps to 50)', async () => {
		let listCalledWith;
		await sweepAgentReputation({
			limit: 999,
			list: async (n) => { listCalledWith = n; return []; },
			read: async () => rep(),
		});
		expect(listCalledWith).toBe(50);
	});
});

// ── Registry entry ────────────────────────────────────────────────────────────

describe('autonomous-registry — agent-reputation-active-sweep entry', () => {
	const entry = getFullRegistry().find((e) => e.id === 'agent-reputation-active-sweep');

	it('is present in the registry', () => {
		expect(entry).toBeDefined();
	});

	it('targets the correct path and method', () => {
		expect(entry.path).toBe('/api/x402/agent-reputation');
		expect(entry.method).toBe('POST');
	});

	it('carries the expected body', () => {
		expect(entry.body).toMatchObject({ mode: 'sweep', limit: 20 });
	});

	it('is in the health pipeline', () => {
		expect(entry.pipeline).toBe('health');
	});

	it('extractSignal returns the right keys for a real sweep response', () => {
		const fakeResponse = {
			mode: 'sweep',
			count: 15,
			avg_score: 62,
			flagged_count: 2,
			flagged: [
				{ agent_id: 'aaaa0000-0000-0000-0000-000000000001', name: 'LowTrust', score: 12, reasons: [] },
			],
			agents: [],
			swept_at: new Date().toISOString(),
		};
		const signal = entry.extractSignal(fakeResponse);
		expect(signal.count).toBe(15);
		expect(signal.avg_score).toBe(62);
		expect(signal.flagged_count).toBe(2);
		expect(signal.flagged_agent_ids).toEqual(['aaaa0000-0000-0000-0000-000000000001']);
	});

	it('extractSignal handles a null/empty response gracefully', () => {
		const signal = entry.extractSignal(null);
		expect(signal.count).toBe(0);
		expect(signal.flagged_count).toBe(0);
		expect(signal.flagged_agent_ids).toEqual([]);
	});

	it('cooldown_s is >= 1800 (audit-style signal)', () => {
		expect(entry.cooldown_s).toBeGreaterThanOrEqual(1800);
	});

	it('priority is in the 50–75 range', () => {
		expect(entry.priority).toBeGreaterThanOrEqual(50);
		expect(entry.priority).toBeLessThanOrEqual(75);
	});
});
