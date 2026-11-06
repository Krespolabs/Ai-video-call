// Network-free unit coverage for the on-chain smoke harness (scripts/onchain-smoke.mjs).
//
// The harness itself runs against testnet/devnet and is exercised end-to-end via
// `npm run smoke:onchain`. This suite locks down its two deterministic, offline
// invariants so a regression is caught in CI without any RPC:
//   1. Address parity across the three hand-maintained registry sources holds,
//      and an injected drift is detected (the harness's step-1 guarantee).
//   2. A built 3D Agent Card validates against the published schema and its
//      model.sha256 matches the synthetic GLB bytes (the harness's step-2 round-trip).

import { describe, expect, it } from 'vitest';

import {
	inlineParityProblems,
	buildSyntheticGlb,
	sha256hex,
	buildCard,
	getCardValidator,
	ERC8004_TYPE,
	THREEWS_CARD_TYPE,
} from '../scripts/onchain-smoke.mjs';
import { REGISTRY_DEPLOYMENTS } from '../src/erc8004/abi.js';

describe('onchain-smoke · address parity (step 1)', () => {
	it('the three registry sources agree today', () => {
		expect(inlineParityProblems()).toEqual([]);
	});

	it('detects an injected address drift', () => {
		const chainId = 84532; // Base Sepolia
		const original = REGISTRY_DEPLOYMENTS[chainId].identityRegistry;
		REGISTRY_DEPLOYMENTS[chainId].identityRegistry =
			'0x000000000000000000000000000000000000dEaD';
		try {
			const problems = inlineParityProblems();
			expect(problems.length).toBeGreaterThan(0);
			expect(problems.join(' ')).toContain('identityRegistry');
		} finally {
			REGISTRY_DEPLOYMENTS[chainId].identityRegistry = original;
		}
		// Restored — parity clean again.
		expect(inlineParityProblems()).toEqual([]);
	});
});

describe('onchain-smoke · synthetic GLB', () => {
	it('builds a structurally valid GLB container with a stable sha256', () => {
		const glb = buildSyntheticGlb();
		expect(glb.readUInt32LE(0)).toBe(0x46546c67); // magic 'glTF'
		expect(glb.readUInt32LE(4)).toBe(2); // version
		expect(glb.readUInt32LE(8)).toBe(glb.length); // declared total length matches
		expect(glb.readUInt32LE(16)).toBe(0x4e4f534a); // first chunk type 'JSON'
		// Deterministic bytes ⇒ deterministic hash (no Date/random in the fixture).
		expect(sha256hex(glb)).toBe(sha256hex(buildSyntheticGlb()));
		expect(sha256hex(glb)).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe('onchain-smoke · 3D Agent Card (step 2)', () => {
	it('builds a card that validates against 3d-agent-card.schema.json with a matching model.sha256', async () => {
		const glb = buildSyntheticGlb();
		const glbSha = sha256hex(glb);
		const glbUrl = `data:model/gltf-binary;base64,${glb.toString('base64')}`;
		const card = buildCard({
			name: 'three.ws smoke agent',
			description: 'Synthetic agent for the schema round-trip test.',
			glbUrl,
			agentId: 1,
			chainId: 84532,
			registryAddr: REGISTRY_DEPLOYMENTS[84532].identityRegistry,
			glbSha,
			glbSize: glb.length,
		});

		const validate = await getCardValidator();
		const ok = validate(card);
		if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
		expect(ok).toBe(true);

		expect(card.model.sha256).toBe(glbSha);
		expect(card.type).toEqual([ERC8004_TYPE, THREEWS_CARD_TYPE]);
		expect(card.registrations[0].agentRegistry).toMatch(/^eip155:84532:0x[a-fA-F0-9]{40}$/);
	});
});
