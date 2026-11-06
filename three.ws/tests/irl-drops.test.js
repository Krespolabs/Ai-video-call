// IRL Money Drops & Bounties (Agent Wallets Wave II — task 06).
//
// Covers the pure, DB/chain-free heart of the drop primitive: the public
// projection never leaks the escrow secret, the funded-amount atomics math is
// exact for every supported asset, the quiz-bounty answer hashing is stable and
// case/space-insensitive, the radius/distance gate is honest, and — crucially —
// a claim is bound to a REAL proof-of-presence token (mint→verify round-trip,
// forgery + out-of-area + expiry all rejected) so "claim where you stand" is
// structural, not advisory.

import { describe, it, expect, afterEach } from 'vitest';

import {
	toPublicDrop,
	hashAnswer,
	verifyQuiz,
	haversineM,
	amountToAtomics,
	atomicsToAmount,
	decimalsForAsset,
} from '../api/_lib/irl-drops.js';
import { mintFixToken, verifyFixToken } from '../api/_lib/irl-presence.js';

const LAT = 37.7749;
const LNG = -122.4194;
const NOW = 1_700_000_000;

function fakeRow(over = {}) {
	return {
		id: 'drop-1',
		kind: 'drop',
		asset: 'USDC',
		amount_atomics: '5000000', // 5 USDC
		max_claims: 5,
		claims_count: 2,
		claim_rule: 'each-once',
		bounty_condition: null,
		quiz_question: null,
		quiz_answer_hash: null,
		title: 'Coffee on me',
		note: 'first five',
		lat: LAT,
		lng: LNG,
		radius_m: 30,
		network: 'mainnet',
		status: 'active',
		escrow_address: 'EscrowAddr1111111111111111111111111111111111',
		escrow_secret_enc: 'v2:SUPER-SECRET-CIPHERTEXT',
		refund_address: 'RefundAddr111111111111111111111111111111111',
		funding_tx: null,
		refund_tx: null,
		expires_at: '2030-01-01T00:00:00Z',
		created_at: '2026-01-01T00:00:00Z',
		creator_user_id: 'user-1',
		creator_device: null,
		...over,
	};
}

describe('toPublicDrop — never leaks custody secrets', () => {
	it('omits the escrow secret and creator identity, derives display fields', () => {
		const pub = toPublicDrop(fakeRow(), { viewerUserId: 'user-1' });
		expect('escrow_secret_enc' in pub).toBe(false);
		expect('creator_user_id' in pub).toBe(false);
		expect('refund_address' in pub).toBe(false);
		expect('quiz_answer_hash' in pub).toBe(false);
		expect(pub.amount).toBe('5');
		expect(pub.claims_left).toBe(3);
		expect(pub.is_mine).toBe(true);
	});

	it('is_mine is false for a different viewer, true for the owning device', () => {
		expect(toPublicDrop(fakeRow(), { viewerUserId: 'someone-else' }).is_mine).toBe(false);
		const anon = fakeRow({ creator_user_id: null, creator_device: 'dev-42' });
		expect(toPublicDrop(anon, { viewerKey: 'dev-42' }).is_mine).toBe(true);
		expect(toPublicDrop(anon, { viewerKey: 'dev-99' }).is_mine).toBe(false);
	});

	it('still exposes the escrow ADDRESS (public) so the funder can pay it', () => {
		const pub = toPublicDrop(fakeRow());
		expect(pub.escrow_address).toMatch(/^Escrow/);
	});
});

describe('funded-amount atomics — exact per asset', () => {
	it('round-trips SOL / USDC / THREE without precision loss', () => {
		for (const [asset, human] of [['SOL', '0.05'], ['USDC', '5'], ['THREE', '12.5']]) {
			const atomics = amountToAtomics(human, asset);
			expect(atomicsToAmount(atomics, asset)).toBe(human);
		}
	});

	it('total = per-claim × maxClaims is exact for a multi-claim drop', () => {
		const per = amountToAtomics('5', 'USDC');     // 5_000_000
		const total = per * 5n;
		expect(total.toString()).toBe('25000000');
		expect(atomicsToAmount(total, 'USDC')).toBe('25');
	});

	it('decimals are correct per asset', () => {
		expect(decimalsForAsset('SOL')).toBe(9);
		expect(decimalsForAsset('USDC')).toBe(6);
	});

	it('rejects an over-precise amount rather than silently truncating', () => {
		expect(() => amountToAtomics('0.0000000001', 'USDC')).toThrow();
		expect(() => amountToAtomics('-1', 'SOL')).toThrow();
		expect(() => amountToAtomics('0', 'SOL')).toThrow();
	});
});

describe('quiz bounty — answer hashing + verification', () => {
	it('is stable, trimmed, and case-insensitive', async () => {
		const a = await hashAnswer('  Hello   World ');
		const b = await hashAnswer('hello world');
		expect(a).toBe(b);
	});

	it('never equals a different answer', async () => {
		const a = await hashAnswer('solana');
		const b = await hashAnswer('ethereum');
		expect(a).not.toBe(b);
	});

	it('verifyQuiz matches only the right answer', async () => {
		const drop = fakeRow({ kind: 'bounty', bounty_condition: 'quiz', quiz_answer_hash: await hashAnswer('42') });
		expect(await verifyQuiz({ drop, answer: ' 42 ' })).toBe(true);
		expect(await verifyQuiz({ drop, answer: 'wrong' })).toBe(false);
		// A drop with no stored hash can never be quiz-claimed.
		expect(await verifyQuiz({ drop: fakeRow(), answer: 'anything' })).toBe(false);
	});
});

describe('radius gate — honest distance', () => {
	it('is ~0 at the exact spot and grows with real metres', () => {
		expect(Math.round(haversineM(LAT, LNG, LAT, LNG))).toBe(0);
		// ~111 m north (0.001° lat).
		const d = haversineM(LAT, LNG, LAT + 0.001, LNG);
		expect(d).toBeGreaterThan(100);
		expect(d).toBeLessThan(120);
	});

	it('a point one cell over is outside a 30 m radius', () => {
		const d = haversineM(LAT, LNG, LAT + 0.002, LNG); // ~222 m
		expect(d).toBeGreaterThan(30);
	});
});

describe('claim is bound to a real proof-of-presence token', () => {
	afterEach(() => { delete process.env.IRL_FIX_SECRET; });

	it('a token minted where you stand verifies at that point', async () => {
		const minted = await mintFixToken(LAT, LNG, NOW);
		const v = await verifyFixToken(minted.token, LAT, LNG, NOW);
		expect(v.ok).toBe(true);
	});

	it('rejects a forged token (no real fix)', async () => {
		const v = await verifyFixToken('not.a.real.token', LAT, LNG, NOW);
		expect(v.ok).toBe(false);
	});

	it('rejects a claim from far away even with a valid token (out_of_area)', async () => {
		const minted = await mintFixToken(LAT, LNG, NOW);
		// Claim a point ~3 km away — beyond the token tolerance.
		const v = await verifyFixToken(minted.token, LAT + 0.03, LNG, NOW);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('out_of_area');
	});

	it('rejects an expired presence token', async () => {
		const minted = await mintFixToken(LAT, LNG, NOW);
		const v = await verifyFixToken(minted.token, LAT, LNG, NOW + 10_000);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('expired');
	});
});
