// Signed asset provenance — pure crypto (canonicalization + ERC-191 framing),
// tested the same way brain-sign.js's memory primitives are (tests/brain-bundle.test.js):
// no DB, no network, just "does this verify the way packages/provenance-mcp's
// verifyAction does". writeAssetProvenance / agentIdForAvatar touch the real
// `sql` client and are exercised live via tests/tokenize-3d-remix-royalty.test.js
// (which injects a fake agentIdForAvatar) rather than here.

import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';

import {
	ACTION_SIG_VERSION,
	stableStringify,
	canonicalizeAction,
	actionDigest,
	verifyActionSignature,
} from '../api/_lib/asset-provenance.js';

// Same well-known throwaway test key already used in tests/brain-bundle.test.js.
const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const wallet = new Wallet(TEST_PK);

function fixtureAction(overrides = {}) {
	return {
		agentId: '11111111-1111-1111-1111-111111111111',
		type: 'tokenize_3d.mint',
		payload: { mint: 'MintAsset1111111111111111111111111111111111', network: 'mainnet', prompt: 'a brave knight' },
		sourceSkill: 'tokenize-3d',
		...overrides,
	};
}

describe('asset-provenance · canonicalization', () => {
	it('is deterministic regardless of payload key order', () => {
		const a = canonicalizeAction(fixtureAction());
		const b = canonicalizeAction(
			fixtureAction({ payload: { network: 'mainnet', prompt: 'a brave knight', mint: 'MintAsset1111111111111111111111111111111111' } }),
		);
		expect(a).toBe(b);
	});

	it('embeds the domain-separating version prefix', () => {
		expect(canonicalizeAction(fixtureAction())).toContain(`"v":"${ACTION_SIG_VERSION}"`);
	});

	it('changes when any signable field changes', () => {
		const base = actionDigest(fixtureAction());
		expect(actionDigest(fixtureAction({ type: 'avatar.generated' }))).not.toBe(base);
		expect(actionDigest(fixtureAction({ agentId: 'other-agent' }))).not.toBe(base);
		expect(actionDigest(fixtureAction({ payload: { ...fixtureAction().payload, prompt: 'a fierce dragon' } }))).not.toBe(base);
	});

	it('stableStringify sorts nested keys recursively', () => {
		expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
	});
});

describe('asset-provenance · sign + verify (ERC-191, mirrors provenance-mcp)', () => {
	it('a real signature over the canonical digest verifies', async () => {
		const action = fixtureAction();
		const digest = actionDigest(action);
		const signature = await wallet.signMessage(`${ACTION_SIG_VERSION}:${digest}`);

		const result = verifyActionSignature(action, { signature, signer_address: wallet.address });
		expect(result.valid).toBe(true);
		expect(result.reason).toBe('ok');
		expect(result.recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
	});

	it('tampering with the payload after signing breaks verification', async () => {
		const action = fixtureAction();
		const digest = actionDigest(action);
		const signature = await wallet.signMessage(`${ACTION_SIG_VERSION}:${digest}`);

		const tampered = fixtureAction({ payload: { ...action.payload, prompt: 'a completely different prompt' } });
		const result = verifyActionSignature(tampered, { signature, signer_address: wallet.address });
		// The digest is recomputed from the (tampered) action, so the signature no
		// longer matches the signed message at all — ethers throws recovering it,
		// or (astronomically unlikely) recovers to an unrelated address. Either way
		// it must never report valid:true.
		expect(result.valid).toBe(false);
	});

	it('a mismatched claimed signer is reported, never silently accepted', async () => {
		const action = fixtureAction();
		const digest = actionDigest(action);
		const signature = await wallet.signMessage(`${ACTION_SIG_VERSION}:${digest}`);
		const someoneElse = Wallet.createRandom().address;

		const result = verifyActionSignature(action, { signature, signer_address: someoneElse });
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('signer_mismatch');
	});

	it('an unsigned action is reported honestly, never a false positive', () => {
		const result = verifyActionSignature(fixtureAction(), {});
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('unsigned');
	});
});
