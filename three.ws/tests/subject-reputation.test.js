// Unit tests for the cross-chain subject reputation engine.
//
// Two pure layers are pinned here without any network: subject-type detection
// (does an arbitrary identifier route to the right chain/loader?) and the
// deterministic scoring formula (same signals → same score, available-weighted,
// never a fabricated number for an unscannable subject).

import { describe, it, expect } from 'vitest';
import {
	detectSubject,
	scoreSignals,
	tierForScore,
	scoreSubjectBatch,
	DIMENSIONS,
	SUBJECT_TYPES,
} from '../api/_lib/trust/subject-reputation.js';

// $THREE — the platform coin, used as a real Solana-mint fixture.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// A synthetic-but-shape-valid Solana wallet + a well-known EVM address form.
const SOL_WALLET = 'THREEsynthetic1111111111111111111111111111';
const EVM_WALLET = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const UUID = '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55';

// ── Subject-type detection ────────────────────────────────────────────────────

describe('detectSubject — type routing', () => {
	it('routes a UUID to the three.ws agent path', () => {
		const d = detectSubject(UUID);
		expect(d.subjectType).toBe('threews_agent');
		expect(d.subject).toBe(UUID);
	});

	it('lowercases a mixed-case UUID', () => {
		const d = detectSubject(UUID.toUpperCase());
		expect(d.subjectType).toBe('threews_agent');
		expect(d.subject).toBe(UUID);
	});

	it('routes an EVM 0x address to the EVM wallet path with the default chain', () => {
		const d = detectSubject(EVM_WALLET);
		expect(d.subjectType).toBe('evm_wallet');
		expect(d.subject).toBe(EVM_WALLET.toLowerCase());
		expect(d.chainId).toBe(8453);
	});

	it('honors an explicit chain for an EVM address', () => {
		const d = detectSubject(EVM_WALLET, { chain: 1 });
		expect(d.subjectType).toBe('evm_wallet');
		expect(d.chainId).toBe(1);
	});

	it('routes a Solana base58 string to the coarse solana family', () => {
		const d = detectSubject(THREE_MINT);
		expect(d.subjectType).toBe('solana');
		expect(d.subject).toBe(THREE_MINT);
	});

	it('routes a Solana wallet-shaped string to the solana family', () => {
		expect(detectSubject(SOL_WALLET).subjectType).toBe('solana');
	});

	it('routes a bare integer to an ERC-8004 agent id on the default chain', () => {
		const d = detectSubject('42');
		expect(d.subjectType).toBe('erc8004_agent');
		expect(d.chainId).toBe(8453);
		expect(d.agentId).toBe('42');
		expect(d.subject).toBe('erc8004:8453:42');
	});

	it('routes a prefixed erc8004:<chain>:<id> identifier', () => {
		const d = detectSubject('erc8004:42161:1337');
		expect(d.subjectType).toBe('erc8004_agent');
		expect(d.chainId).toBe(42161);
		expect(d.agentId).toBe('1337');
	});

	it('routes an eip155:<chain>:<numericId> identifier to erc8004', () => {
		const d = detectSubject('eip155:8453:7');
		expect(d.subjectType).toBe('erc8004_agent');
		expect(d.chainId).toBe(8453);
		expect(d.agentId).toBe('7');
	});

	it('does not mistake a CAIP-10 account (…:0xaddr) for an erc8004 agent id', () => {
		// The last segment is an address, not a numeric token id → falls through to unknown.
		const d = detectSubject(`eip155:8453:${EVM_WALLET}`);
		expect(d.subjectType).toBe('unknown');
	});

	it('returns unknown for empty and garbage identifiers', () => {
		expect(detectSubject('').subjectType).toBe('unknown');
		expect(detectSubject('   ').subjectType).toBe('unknown');
		expect(detectSubject('not a real id !!').subjectType).toBe('unknown');
	});

	it('every detected subjectType is a declared type', () => {
		for (const id of [UUID, EVM_WALLET, THREE_MINT, '42', 'erc8004:1:1', 'garbage']) {
			const t = detectSubject(id).subjectType;
			// 'solana' is the coarse family refined by the loader; the rest are terminal.
			expect([...SUBJECT_TYPES, 'solana']).toContain(t);
		}
	});
});

// ── Scoring formula ───────────────────────────────────────────────────────────

describe('scoreSignals — determinism & bounds', () => {
	const rich = {
		activity: 200,
		ageDays: 365,
		counterparties: 25,
		holdingsUsd: 1000,
		failureRate: 0,
		attestationCount: 10,
	};

	it('is deterministic — identical signals yield identical scores', () => {
		const a = scoreSignals(rich);
		const b = scoreSignals({ ...rich });
		expect(a.score).toBe(b.score);
		expect(a.tier).toBe(b.tier);
	});

	it('a fully-saturated subject scores 100 / elite', () => {
		const r = scoreSignals(rich);
		expect(r.score).toBe(100);
		expect(r.tier).toBe('elite');
		expect(r.weight_considered).toBe(100);
	});

	it('an all-zero subject with every dimension present scores 0 / low', () => {
		const r = scoreSignals({
			activity: 0,
			ageDays: 0,
			counterparties: 0,
			holdingsUsd: 0,
			failureRate: 1,
			attestationCount: 0,
		});
		expect(r.score).toBe(0);
		expect(r.tier).toBe('low');
	});

	it('returns score:null / tier:unknown when NO dimension is readable', () => {
		const r = scoreSignals({});
		expect(r.score).toBeNull();
		expect(r.tier).toBe('unknown');
		expect(r.weight_considered).toBe(0);
	});

	it('normalizes over ONLY the available dimensions (partial evidence is not penalised)', () => {
		// Only activity is present and fully saturated → score should be 100, not
		// diluted by the missing dimensions.
		const r = scoreSignals({ activity: 200 });
		expect(r.score).toBe(100);
		expect(r.weight_considered).toBe(DIMENSIONS.find((d) => d.key === 'activity').weight);
	});

	it('more activity strictly increases the score', () => {
		const low = scoreSignals({ activity: 10, counterparties: 2 }).score;
		const high = scoreSignals({ activity: 150, counterparties: 2 }).score;
		expect(high).toBeGreaterThan(low);
	});

	it('a denylist hit caps the score at 10 regardless of positive signals', () => {
		const clean = scoreSignals(rich).score;
		const banned = scoreSignals({ ...rich, banned: true }).score;
		expect(clean).toBe(100);
		expect(banned).toBeLessThanOrEqual(10);
		expect(tierForScore(banned)).toBe('low');
	});

	it('negative ERC-8004 feedback scales the attestation contribution down, never up', () => {
		const neutral = scoreSignals({ attestationCount: 10, attestationAvg: 100 });
		const negative = scoreSignals({ attestationCount: 10, attestationAvg: -100 });
		expect(negative.score).toBeLessThan(neutral.score);
		expect(negative.dimensions.attestations.points).toBe(0);
	});

	it('reliability reflects the failure rate', () => {
		const reliable = scoreSignals({ failureRate: 0 }).score;
		const flaky = scoreSignals({ failureRate: 0.5 }).score;
		expect(reliable).toBeGreaterThan(flaky);
	});

	it('exposes a per-dimension breakdown with availability + points', () => {
		const r = scoreSignals({ activity: 100 });
		expect(r.dimensions.activity.available).toBe(true);
		expect(r.dimensions.age.available).toBe(false);
		expect(r.dimensions.age.points).toBe(0);
		expect(typeof r.dimensions.activity.points).toBe('number');
	});
});

describe('tierForScore — documented bands', () => {
	it('maps the score bands to the right tiers', () => {
		expect(tierForScore(null)).toBe('unknown');
		expect(tierForScore(0)).toBe('low');
		expect(tierForScore(29)).toBe('low');
		expect(tierForScore(30)).toBe('medium');
		expect(tierForScore(59)).toBe('medium');
		expect(tierForScore(60)).toBe('high');
		expect(tierForScore(84)).toBe('high');
		expect(tierForScore(85)).toBe('elite');
		expect(tierForScore(100)).toBe('elite');
	});
});

// ── Batch scoring (unknown subjects are graceful, never thrown) ────────────────

describe('scoreSubjectBatch — resilience', () => {
	it('returns an unknown result for garbage subjects without throwing', async () => {
		const out = await scoreSubjectBatch(['not a real id !!', 'also bad %%%']);
		expect(out).toHaveLength(2);
		for (const r of out) {
			expect(r.score).toBeNull();
			expect(r.tier).toBe('unknown');
			expect(Array.isArray(r.caveats)).toBe(true);
			expect(r.caveats.length).toBeGreaterThan(0);
		}
	});

	it('skips empty / whitespace entries', async () => {
		const out = await scoreSubjectBatch(['', '   ', 'garbage!!']);
		expect(out).toHaveLength(1);
		expect(out[0].subjectType).toBe('unknown');
	});
});
