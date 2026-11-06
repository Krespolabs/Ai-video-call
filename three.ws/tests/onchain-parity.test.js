// Guards the ERC-8004 EVM registry address surface. The same registry addresses
// are hand-duplicated across three sources that can silently drift:
//   1. src/erc8004/abi.js        — REGISTRY_DEPLOYMENTS (browser/client)
//   2. sdk/src/erc8004/abi.js    — REGISTRY_DEPLOYMENTS (published SDK)
//   3. api/_lib/erc8004-chains.js — CHAINS[].registry + .validationRegistry
//
// A drift sends registrations / reputation / validation writes to the wrong (or
// zero) contract. The same parity check gates the Vercel build
// (scripts/build-vercel.mjs phase 1, `verify:onchain`); running it here means
// `npm test` catches a drift before a push. The live bytecode sweep is exercised
// by the CLI (`npm run verify:onchain`), not here — unit tests stay offline and
// deterministic.

import { describe, it, expect, beforeAll } from 'vitest';
import {
	loadSources,
	checkParity,
	resolveLiveChains,
} from '../scripts/verify-onchain-parity.mjs';

let sources;
beforeAll(async () => {
	({ sources } = await loadSources());
});

describe('onchain parity · the three sources agree today', () => {
	it('loadSources returns all three registry sources', () => {
		expect(Object.keys(sources).sort()).toEqual([
			'api/_lib/erc8004-chains.js',
			'sdk/src/erc8004/abi.js',
			'src/erc8004/abi.js',
		]);
	});

	it('checkParity reports zero problems on the real repo', () => {
		const { problems } = checkParity(sources);
		expect(problems).toEqual([]);
	});

	it('produces a merged map of real (non-null) addresses for the live sweep', () => {
		const { merged } = checkParity(sources);
		// Base mainnet (8453) + Base Sepolia (84532) are the build-gate live targets.
		expect(merged[8453]?.identityRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
		expect(merged[8453]?.reputationRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
		expect(merged[84532]?.validationRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
		// ValidationRegistry is not yet on mainnet — it must be absent, not zero.
		expect(merged[8453]?.validationRegistry).toBeUndefined();
	});
});

describe('onchain parity · detects injected drift', () => {
	it('catches a mismatched address across two sources', () => {
		const drifted = structuredClone(sources);
		drifted['src/erc8004/abi.js'][8453] = {
			...drifted['src/erc8004/abi.js'][8453],
			identityRegistry: '0x000000000000000000000000000000000000dEaD',
		};
		const { problems } = checkParity(drifted);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.some((p) => p.type === 'mismatch' && p.kind === 'identityRegistry')).toBe(
			true,
		);
	});

	it('catches the ValidationRegistry null-vs-address drift trap', () => {
		const drifted = structuredClone(sources);
		// Give mainnet Base a validationRegistry in src but leave sdk null — the
		// exact trap the guard exists to catch (one source live, another absent).
		drifted['src/erc8004/abi.js'][8453] = {
			...drifted['src/erc8004/abi.js'][8453],
			validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
		};
		const { problems } = checkParity(drifted);
		expect(problems.some((p) => p.type === 'drift-trap' && p.kind === 'validationRegistry')).toBe(
			true,
		);
	});

	it('catches a chainId present in one source but missing from another', () => {
		const drifted = structuredClone(sources);
		delete drifted['sdk/src/erc8004/abi.js'][8453];
		const { problems } = checkParity(drifted);
		expect(problems.some((p) => p.type === 'chain-set' && p.chainId === 8453)).toBe(true);
	});
});

describe('onchain parity · live-chain selection', () => {
	const ALL = [1, 8453, 84532, 42161];

	it('defaults to Base mainnet + Base Sepolia', () => {
		expect(resolveLiveChains({}, ALL)).toEqual([8453, 84532]);
	});

	it('"none" disables the live sweep', () => {
		expect(resolveLiveChains({ VERIFY_ONCHAIN_CHAINS: 'none' }, ALL)).toEqual([]);
	});

	it('"all" sweeps every known chain', () => {
		expect(resolveLiveChains({ VERIFY_ONCHAIN_CHAINS: 'all' }, ALL)).toEqual(ALL);
	});

	it('parses an explicit comma list', () => {
		expect(resolveLiveChains({ VERIFY_ONCHAIN_CHAINS: '1, 42161' }, ALL)).toEqual([1, 42161]);
	});
});
