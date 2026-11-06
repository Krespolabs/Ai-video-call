/**
 * The Reasoning Ledger — hash-chain integrity, tamper detection, calibration /
 * scoring, and an end-to-end decide → reconcile → verify lifecycle.
 *
 * The pure layer (hash chain + reputation) is asserted directly with adversarial
 * cases. The lifecycle test drives the real recordDecision / recordOutcome /
 * verifyChain code paths against an in-memory `sql` so it runs with no database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for the agent_decisions / decision_outcomes tables. Hoisted
// so the vi.mock factory (also hoisted) can close over it.
const h = vi.hoisted(() => {
	const store = { decisions: [], outcomes: [], idCounter: 0 };
	const fakeSql = (strings, ...values) => {
		const q = strings.join('?').toLowerCase();

		if (q.includes('insert into agent_decisions')) {
			const [agent_id, seq, kind, subject_ref, action_ref, inputs, rationale, prediction, confidence, network, decided_at, prev_hash, entry_hash] = values;
			const seqClash = store.decisions.some((d) => d.agent_id === agent_id && d.seq === seq);
			const idemClash = store.decisions.some((d) => d.agent_id === agent_id && d.kind === kind && d.subject_ref === subject_ref && d.action_ref === action_ref);
			if (seqClash || idemClash) return Promise.resolve([]); // on conflict do nothing
			const id = `dec-${++store.idCounter}`;
			store.decisions.push({
				id, agent_id, seq, kind, subject_ref, action_ref,
				inputs: JSON.parse(inputs), rationale, prediction: JSON.parse(prediction),
				confidence, network, decided_at, prev_hash, entry_hash,
			});
			return Promise.resolve([{ id, seq, entry_hash }]);
		}
		if (q.includes('insert into decision_outcomes')) {
			const [decision_id, agent_id, observed, was_correct, pnl_sol, impact, status] = values;
			if (store.outcomes.some((o) => o.decision_id === decision_id)) return Promise.resolve([]);
			store.outcomes.push({ decision_id, agent_id, observed: JSON.parse(observed), was_correct, pnl_sol, impact, status, reconciled_at: new Date().toISOString() });
			return Promise.resolve([{ decision_id }]);
		}
		// idempotency lookup
		if (q.includes('select id, seq, entry_hash from agent_decisions') && q.includes('is not distinct')) {
			const [agent_id, kind, subject_ref, action_ref] = values;
			const f = store.decisions.find((d) => d.agent_id === agent_id && d.kind === kind && d.subject_ref === subject_ref && d.action_ref === action_ref);
			return Promise.resolve(f ? [{ id: f.id, seq: f.seq, entry_hash: f.entry_hash }] : []);
		}
		// chain head
		if (q.includes('select seq, entry_hash from agent_decisions') && q.includes('order by seq desc')) {
			const [agent_id] = values;
			const rows = store.decisions.filter((d) => d.agent_id === agent_id).sort((a, b) => b.seq - a.seq);
			return Promise.resolve(rows.length ? [{ seq: rows[0].seq, entry_hash: rows[0].entry_hash }] : []);
		}
		// full chain
		if (q.includes('from agent_decisions') && q.includes('order by seq asc')) {
			const [agent_id] = values;
			return Promise.resolve(store.decisions.filter((d) => d.agent_id === agent_id).sort((a, b) => a.seq - b.seq).map((d) => ({ ...d })));
		}
		// reputation records
		if (q.includes('left join decision_outcomes o on o.decision_id = d.id') && q.includes('d.kind, d.confidence')) {
			const [agent_id] = values;
			return Promise.resolve(store.decisions.filter((d) => d.agent_id === agent_id).map((d) => {
				const o = store.outcomes.find((x) => x.decision_id === d.id);
				return { kind: d.kind, confidence: d.confidence, decided_at: d.decided_at, was_correct: o ? o.was_correct : null, pnl_sol: o ? o.pnl_sol : null };
			}));
		}
		return Promise.resolve([]);
	};
	return { store, fakeSql };
});

vi.mock('../api/_lib/db.js', () => ({ sql: h.fakeSql, sqlValues: () => {}, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

import {
	genesisHash, canonicalizeEntry, computeEntryHash, buildChain, verifyChain,
	computeReputation, calibrationBuckets, stableStringify,
	recordDecision, recordOutcome, getChainEntries, getReputationRecords,
} from '../api/_lib/reasoning-ledger.js';

const AGENT = '11111111-1111-1111-1111-111111111111';

function rawDecision(i, over = {}) {
	return {
		kind: 'snipe',
		subject_ref: `mint-${i}`,
		action_ref: `pos-${i}`,
		inputs: { price_impact_pct: i, position_id: `pos-${i}` },
		rationale: `decision number ${i}`,
		prediction: { direction: 'up', basis: 'expects profit' },
		confidence: 0.5,
		network: 'mainnet',
		decided_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
		...over,
	};
}

describe('stableStringify', () => {
	it('is key-order independent', () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
	});
	it('handles nested objects and arrays deterministically', () => {
		const a = stableStringify({ x: [{ q: 1, p: 2 }], y: null });
		const b = stableStringify({ y: null, x: [{ p: 2, q: 1 }] });
		expect(a).toBe(b);
	});
});

describe('hash chain', () => {
	it('links each entry to the previous (genesis at seq 1)', async () => {
		const chain = await buildChain(AGENT, [rawDecision(1), rawDecision(2), rawDecision(3)]);
		expect(chain).toHaveLength(3);
		expect(chain[0].seq).toBe(1);
		expect(chain[0].prev_hash).toBe(genesisHash(AGENT));
		expect(chain[1].prev_hash).toBe(chain[0].entry_hash);
		expect(chain[2].prev_hash).toBe(chain[1].entry_hash);
	});

	it('verifies a clean chain', async () => {
		const chain = await buildChain(AGENT, [rawDecision(1), rawDecision(2)]);
		const v = await verifyChain(AGENT, chain);
		expect(v.ok).toBe(true);
		expect(v.broken_at).toBeNull();
		expect(v.head_hash).toBe(chain[1].entry_hash);
	});

	it('is deterministic — same inputs hash identically', async () => {
		const a = await computeEntryHash(genesisHash(AGENT), { ...rawDecision(1), seq: 1, agent_id: AGENT });
		const b = await computeEntryHash(genesisHash(AGENT), { ...rawDecision(1), seq: 1, agent_id: AGENT });
		expect(a).toBe(b);
	});

	it('survives a jsonb round-trip (key reorder, number reformat)', async () => {
		const e = { ...rawDecision(1), seq: 1, agent_id: AGENT };
		const original = await computeEntryHash(genesisHash(AGENT), e);
		// Simulate Postgres jsonb returning reordered keys + normalized numbers.
		const roundTripped = {
			...e,
			inputs: JSON.parse(JSON.stringify({ position_id: e.inputs.position_id, price_impact_pct: e.inputs.price_impact_pct })),
			confidence: 0.5,
		};
		const after = await computeEntryHash(genesisHash(AGENT), roundTripped);
		expect(after).toBe(original);
	});
});

describe('tamper detection', () => {
	it('detects an edited field at its seq', async () => {
		const chain = await buildChain(AGENT, [rawDecision(1), rawDecision(2), rawDecision(3)]);
		// Attacker rewrites the rationale of entry #2 but cannot recompute the rest.
		chain[1] = { ...chain[1], rationale: 'a flattering lie' };
		const v = await verifyChain(AGENT, chain);
		expect(v.ok).toBe(false);
		expect(v.broken_at).toBe(2);
		expect(v.reason).toMatch(/altered|entry_hash/);
	});

	it('detects a broken prev_hash link', async () => {
		const chain = await buildChain(AGENT, [rawDecision(1), rawDecision(2)]);
		chain[1] = { ...chain[1], prev_hash: 'GENESIS:forged' };
		const v = await verifyChain(AGENT, chain);
		expect(v.ok).toBe(false);
		expect(v.broken_at).toBe(2);
	});

	it('detects a sequence gap (a removed entry)', async () => {
		const chain = await buildChain(AGENT, [rawDecision(1), rawDecision(2), rawDecision(3)]);
		const withHole = [chain[0], chain[2]]; // entry #2 deleted
		const v = await verifyChain(AGENT, withHole);
		expect(v.ok).toBe(false);
		expect(v.broken_at).toBe(2);
	});

	it('a full rewrite changes the head — no longer matches an anchor', async () => {
		const chain = await buildChain(AGENT, [rawDecision(1), rawDecision(2)]);
		const anchoredHead = chain[1].entry_hash; // committed on-chain earlier
		// Attacker rewrites entry #1 and re-derives the whole chain consistently.
		const rewritten = await buildChain(AGENT, [rawDecision(1, { rationale: 'rewritten history' }), rawDecision(2)]);
		const v = await verifyChain(AGENT, rewritten);
		expect(v.ok).toBe(true); // internally consistent…
		expect(v.head_hash).not.toBe(anchoredHead); // …but the head betrays the edit
	});
});

describe('calibration', () => {
	it('buckets by confidence and computes ECE', () => {
		const records = [
			{ confidence: 0.9, was_correct: true },
			{ confidence: 0.9, was_correct: true },
			{ confidence: 0.1, was_correct: false },
			{ confidence: 0.1, was_correct: false },
		];
		const { ece, sample_size } = calibrationBuckets(records);
		expect(sample_size).toBe(4);
		// Perfectly calibrated extremes → near-zero error.
		expect(ece).toBeLessThan(0.15);
	});

	it('flags an overconfident agent with a high ECE', () => {
		const records = Array.from({ length: 10 }, () => ({ confidence: 0.9, was_correct: false }));
		const { ece } = calibrationBuckets(records);
		expect(ece).toBeGreaterThan(0.8);
	});
});

describe('computeReputation', () => {
	it('returns a neutral-ish score with no data', () => {
		const r = computeReputation([]);
		expect(r.sample_size).toBe(0);
		expect(r.score).toBe(50); // pure regression to neutral
		expect(r.components).toHaveLength(3);
	});

	it('counts losses — never hides them', () => {
		const records = [
			{ kind: 'snipe', confidence: 0.6, was_correct: true, pnl_sol: 1 },
			{ kind: 'snipe', confidence: 0.6, was_correct: false, pnl_sol: -1 },
		];
		const r = computeReputation(records);
		expect(r.wins).toBe(1);
		expect(r.losses).toBe(1);
		expect(r.hit_rate).toBeCloseTo(0.5, 5);
	});

	it('rewards a calibrated, profitable, high-sample agent over a small one', () => {
		const strong = Array.from({ length: 25 }, (_, i) => ({ kind: 'snipe', confidence: 0.75, was_correct: i % 4 !== 0, pnl_sol: i % 4 !== 0 ? 0.5 : -0.3 }));
		const weak = [{ kind: 'snipe', confidence: 0.75, was_correct: true, pnl_sol: 0.5 }];
		const rs = computeReputation(strong);
		const rw = computeReputation(weak);
		expect(rs.score).toBeGreaterThan(rw.score);
		expect(rs.confidence).toBe(1);
		expect(rw.confidence).toBeLessThan(1);
	});

	it('exposes its formula and traces every component', () => {
		const r = computeReputation([{ kind: 'snipe', confidence: 0.6, was_correct: true, pnl_sol: 1 }]);
		expect(r.formula).toContain('0.5·hit_rate');
		const sum = r.components.reduce((a, c) => a + c.contribution, 0);
		expect(sum).toBeCloseTo(r.raw_score, 3);
	});

	it('counts pending decisions but excludes them from the sample', () => {
		const r = computeReputation([
			{ kind: 'snipe', confidence: 0.6, was_correct: true, pnl_sol: 1 },
			{ kind: 'snipe', confidence: 0.6, was_correct: null, pnl_sol: null },
		]);
		expect(r.sample_size).toBe(1);
		expect(r.pending_count).toBe(1);
		expect(r.decisions_total).toBe(2);
	});
});

describe('e2e: decide → reconcile → verify', () => {
	beforeEach(() => {
		h.store.decisions = [];
		h.store.outcomes = [];
		h.store.idCounter = 0;
	});

	it('records decisions, reconciles outcomes, and stays verifiable', async () => {
		// DECIDE — three snipes captured to the chain.
		const d1 = await recordDecision({ agentId: AGENT, ...rawDecision(1), subjectRef: 'mint-1', actionRef: 'pos-1', confidence: 0.8 });
		const d2 = await recordDecision({ agentId: AGENT, ...rawDecision(2), subjectRef: 'mint-2', actionRef: 'pos-2', confidence: 0.8 });
		const d3 = await recordDecision({ agentId: AGENT, ...rawDecision(3), subjectRef: 'mint-3', actionRef: 'pos-3', confidence: 0.2 });
		expect([d1.seq, d2.seq, d3.seq]).toEqual([1, 2, 3]);
		expect(d1.deduped).toBe(false);

		// Idempotent capture — the same action fires twice → one row.
		const dup = await recordDecision({ agentId: AGENT, ...rawDecision(1), subjectRef: 'mint-1', actionRef: 'pos-1' });
		expect(dup.deduped).toBe(true);
		expect(dup.seq).toBe(1);
		expect(h.store.decisions).toHaveLength(3);

		// RECONCILE — outcomes resolved against (simulated) on-chain P&L.
		await recordOutcome({ decisionId: d1.id, agentId: AGENT, wasCorrect: true, pnlSol: 1.2, impact: 1.2, observed: { sell_sig: 'sig1' } });
		await recordOutcome({ decisionId: d2.id, agentId: AGENT, wasCorrect: true, pnlSol: 0.4, impact: 0.4, observed: { sell_sig: 'sig2' } });
		await recordOutcome({ decisionId: d3.id, agentId: AGENT, wasCorrect: false, pnlSol: -0.5, impact: -0.5, observed: { sell_sig: 'sig3' } });
		// Reconciling again is a no-op (no double count).
		const again = await recordOutcome({ decisionId: d1.id, agentId: AGENT, wasCorrect: true, pnlSol: 99 });
		expect(again.reconciled).toBe(false);

		const rep = computeReputation(await getReputationRecords(AGENT));
		expect(rep.sample_size).toBe(3);
		expect(rep.wins).toBe(2);
		expect(rep.losses).toBe(1);
		expect(rep.net_pnl_sol).toBeCloseTo(1.1, 5);

		// VERIFY — recompute the persisted chain end to end.
		const entries = await getChainEntries(AGENT);
		const v = await verifyChain(AGENT, entries);
		expect(v.ok).toBe(true);
		expect(v.count).toBe(3);

		// And a tamper on the persisted store is provably detected.
		h.store.decisions[1].rationale = 'edited after the fact';
		const tampered = await verifyChain(AGENT, await getChainEntries(AGENT));
		expect(tampered.ok).toBe(false);
		expect(tampered.broken_at).toBe(2);
	});
});
