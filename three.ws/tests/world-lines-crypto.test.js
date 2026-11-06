// Unit tests for the World Lines proof-of-presence crypto core (api/_lib/world-lines.js).
// Pure functions only — no DB, no network — so every anti-cheat guarantee (signature
// genuineness, nonce binding, replay/forgery rejection, challenge validation, and the
// coarse-cell privacy unit) is asserted in isolation.

import { describe, it, expect, beforeAll } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
	coarseCell, isCoarseCell, COARSE_CELL_PRECISION,
	normalizeChallengeSpec, normalizeRewardKind, normalizeDifficulty,
	canonicalProofMessage, completerHash, signPresenceProof, verifyPresenceProof,
	mintPresenceNonce, verifyPresenceNonce, NONCE_TTL_SEC,
} from '../api/_lib/world-lines.js';

// A deterministic agent keypair (no @solana/web3.js needed): 64-byte secret = seed||pub.
function fakeAgentKey(fill = 9) {
	const seed = new Uint8Array(32).fill(fill);
	const pub = ed25519.getPublicKey(seed);
	const secretKey = new Uint8Array(64);
	secretKey.set(seed, 0);
	secretKey.set(pub, 32);
	return { secretKey, pubkey: bs58.encode(pub) };
}

const WL_ID = '11111111-1111-1111-1111-111111111111';
let CELL;
beforeAll(() => {
	CELL = coarseCell(40.7484, -73.9857); // Empire State Building
});

describe('coarse cell — the ~1.1 km privacy unit', () => {
	it('is a precision-6 geohash', () => {
		expect(COARSE_CELL_PRECISION).toBe(6);
		expect(CELL).toHaveLength(6);
		expect(isCoarseCell(CELL)).toBe(true);
	});
	it('a precision-7 density cell refines to the same precision-6 parent (hierarchical)', async () => {
		const { encodeGeohash } = await import('../api/_lib/geohash.js');
		const cell7 = encodeGeohash(40.7484, -73.9857, 7);
		expect(cell7.slice(0, 6)).toBe(CELL);
	});
	it('rejects malformed cells', () => {
		expect(isCoarseCell('zzz')).toBe(false);
		expect(isCoarseCell('abcdei')).toBe(false); // a + i are not in the geohash alphabet
		expect(isCoarseCell('dr5ru6x')).toBe(false); // precision 7
		expect(isCoarseCell('')).toBe(false);
	});
});

describe('signPresenceProof / verifyPresenceProof', () => {
	it('the agent signs and anyone re-verifies the exact canonical message', async () => {
		const agent = fakeAgentKey();
		const who = await completerHash('device-abc');
		const minted = await mintPresenceNonce(WL_ID, CELL);
		const message = canonicalProofMessage({ worldLineId: WL_ID, coarseCell: CELL, nonceId: minted.nonceId, completerHash: who });
		const proof = signPresenceProof({ secretKey: agent.secretKey, message });

		expect(proof.signerPubkey).toBe(agent.pubkey);
		expect(verifyPresenceProof({ signerPubkey: proof.signerPubkey, message, signature: proof.signature })).toBe(true);
	});

	it('rejects a tampered message, signature, or signer', async () => {
		const agent = fakeAgentKey();
		const who = await completerHash('device-abc');
		const message = canonicalProofMessage({ worldLineId: WL_ID, coarseCell: CELL, nonceId: 'abc', completerHash: who });
		const proof = signPresenceProof({ secretKey: agent.secretKey, message });

		expect(verifyPresenceProof({ signerPubkey: proof.signerPubkey, message: message + 'x', signature: proof.signature })).toBe(false);
		const otherSig = signPresenceProof({ secretKey: fakeAgentKey(1).secretKey, message }).signature;
		expect(verifyPresenceProof({ signerPubkey: proof.signerPubkey, message, signature: otherSig })).toBe(false);
		expect(verifyPresenceProof({ signerPubkey: fakeAgentKey(2).pubkey, message, signature: proof.signature })).toBe(false);
	});

	it('a different completer cannot reuse another visitor’s signature', async () => {
		const agent = fakeAgentKey();
		const mine = await completerHash('device-mine');
		const theirs = await completerHash('device-theirs');
		const msgMine = canonicalProofMessage({ worldLineId: WL_ID, coarseCell: CELL, nonceId: 'n', completerHash: mine });
		const sig = signPresenceProof({ secretKey: agent.secretKey, message: msgMine }).signature;
		const msgTheirs = canonicalProofMessage({ worldLineId: WL_ID, coarseCell: CELL, nonceId: 'n', completerHash: theirs });
		expect(verifyPresenceProof({ signerPubkey: agent.pubkey, message: msgTheirs, signature: sig })).toBe(false);
	});

	it('never throws on malformed input', () => {
		expect(verifyPresenceProof({ signerPubkey: 'not-base58!!', message: 'x', signature: 'y' })).toBe(false);
		expect(verifyPresenceProof({ signerPubkey: '', message: '', signature: '' })).toBe(false);
	});
});

describe('completerHash', () => {
	it('is stable for the same id and distinct across ids — and never echoes the raw id', async () => {
		const a = await completerHash('device-xyz');
		const b = await completerHash('device-xyz');
		const c = await completerHash('device-other');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).not.toContain('device-xyz');
		expect(a).toHaveLength(32);
	});
});

describe('mintPresenceNonce / verifyPresenceNonce', () => {
	it('a freshly minted nonce verifies and yields its id', async () => {
		const minted = await mintPresenceNonce(WL_ID, CELL);
		const v = await verifyPresenceNonce(minted.nonce, WL_ID, CELL);
		expect(v.ok).toBe(true);
		expect(v.nonceId).toBe(minted.nonceId);
		expect(minted.expires_in).toBe(NONCE_TTL_SEC);
	});

	it('rejects a nonce bound to a different world line or cell', async () => {
		const minted = await mintPresenceNonce(WL_ID, CELL);
		expect((await verifyPresenceNonce(minted.nonce, '22222222-2222-2222-2222-222222222222', CELL)).reason).toBe('mismatch');
		const otherCell = coarseCell(48.8584, 2.2945); // Eiffel Tower
		expect((await verifyPresenceNonce(minted.nonce, WL_ID, otherCell)).reason).toBe('mismatch');
	});

	it('rejects a forged / tampered nonce', async () => {
		const minted = await mintPresenceNonce(WL_ID, CELL);
		const tampered = minted.nonce.slice(0, -3) + 'AAA';
		expect((await verifyPresenceNonce(tampered, WL_ID, CELL)).reason).toBe('forged');
		expect((await verifyPresenceNonce('garbage', WL_ID, CELL)).reason).toBe('malformed');
		expect((await verifyPresenceNonce('', WL_ID, CELL)).reason).toBe('missing');
	});

	it('rejects an expired nonce (past the TTL)', async () => {
		const longAgo = Math.floor(Date.now() / 1000) - (NONCE_TTL_SEC + 60);
		const minted = await mintPresenceNonce(WL_ID, CELL, longAgo);
		const v = await verifyPresenceNonce(minted.nonce, WL_ID, CELL); // verified at "now"
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('expired');
	});

	it('each mint is unique (random component) so the nonce id is a per-attempt key', async () => {
		const a = await mintPresenceNonce(WL_ID, CELL);
		const b = await mintPresenceNonce(WL_ID, CELL);
		expect(a.nonceId).not.toBe(b.nonceId);
	});
});

describe('challenge spec validation', () => {
	it('defaults to a tap challenge', () => {
		const { ok, spec } = normalizeChallengeSpec(undefined);
		expect(ok).toBe(true);
		expect(spec.kind).toBe('tap');
	});
	it('a phrase challenge requires + normalizes a passphrase', () => {
		expect(normalizeChallengeSpec({ kind: 'phrase' }).ok).toBe(false);
		const { ok, spec } = normalizeChallengeSpec({ kind: 'phrase', phrase: '  Open  SESAME ' });
		expect(ok).toBe(true);
		expect(spec.phrase).toBe('open sesame');
	});
	it('a quiz needs ≥ 2 choices and a valid answer index', () => {
		expect(normalizeChallengeSpec({ kind: 'quiz', question: 'Q', choices: ['a'] }).ok).toBe(false);
		expect(normalizeChallengeSpec({ kind: 'quiz', question: 'Q', choices: ['a', 'b'], answer: 5 }).ok).toBe(false);
		const { ok, spec } = normalizeChallengeSpec({ kind: 'quiz', question: 'Q', choices: ['a', 'b', 'c'], answer: 2 });
		expect(ok).toBe(true);
		expect(spec.answer).toBe(2);
		expect(spec.choices).toEqual(['a', 'b', 'c']);
	});
	it('reward + difficulty normalize to safe defaults', () => {
		expect(normalizeRewardKind('dogecoin_pool')).toBe('collectible');
		expect(normalizeRewardKind('three_pool')).toBe('three_pool');
		expect(normalizeDifficulty('nightmare')).toBe('easy');
		expect(normalizeDifficulty('hard')).toBe('hard');
	});
});
