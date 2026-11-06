import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { classifyIdentity, verifyClaim } from '../api/_lib/x402/identity-claim-verify.js';
import {
	BAZAAR,
	INPUT_SCHEMA,
	INPUT_EXAMPLE,
	OUTPUT_SCHEMA,
	OUTPUT_EXAMPLE,
} from '../api/x402/onchain-identity-verify.js';

// Real EVM addresses/names used only as fixtures — no mainnet mint hardcoded.
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER_EVM = '0x1111111111111111111111111111111111111111';
const SOL_WALLET = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';
const SOL_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'; // $THREE
const OTHER_SOL = 'THREEsynthetic1111111111111111111111111PayTo';

// Fully-stubbed deps so the whole verdict matrix is exercised offline.
function stubDeps(over = {}) {
	return {
		resolveEns: async () => null,
		reverseEns: async () => null,
		resolveSns: async () => null,
		reverseSns: async () => null,
		getEvmCode: async () => '0x',
		getEvmContractCreation: async () => ({ deployer: null, txHash: null, reason: 'no_explorer_key' }),
		getEvmOwner: async () => null,
		getSolanaMintInfo: async () => null,
		lookupThreewsIndex: async () => null,
		resolveErc8004: async () => ({ owner: null, wallet: null }),
		...over,
	};
}

describe('classifyIdentity', () => {
	it('detects each identity type', () => {
		expect(classifyIdentity('7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55').type).toBe('threews_agent_id');
		expect(classifyIdentity('vitalik.eth').type).toBe('ens');
		expect(classifyIdentity('bonfida.sol').type).toBe('sns');
		expect(classifyIdentity(VITALIK).type).toBe('evm_address');
		expect(classifyIdentity(SOL_WALLET).type).toBe('solana_address');
		expect(classifyIdentity('eip155:8453:42')).toMatchObject({ type: 'erc8004', chainId: 8453, agentId: '42' });
		expect(classifyIdentity('8453:42')).toMatchObject({ type: 'erc8004', chainId: 8453, agentId: '42' });
		// bare integer only becomes erc8004 with an EVM chain hint
		expect(classifyIdentity('42').type).toBe('unknown');
		expect(classifyIdentity('42', 'eip155:8453')).toMatchObject({ type: 'erc8004', agentId: '42' });
		expect(classifyIdentity('¯\\_(ツ)_/¯').type).toBe('unknown');
	});
});

describe('ENS claims', () => {
	it('verifies true when the name resolves to the claimed address', async () => {
		const r = await verifyClaim(
			{ identity: 'vitalik.eth', address: VITALIK, chain: 'eip155:1' },
			stubDeps({ resolveEns: async () => VITALIK.toLowerCase(), reverseEns: async () => 'vitalik.eth' }),
		);
		expect(r.verified).toBe(true);
		expect(r.identity_type).toBe('ens');
		expect(r.evidence.some((e) => e.kind === 'ens_forward_resolution')).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'ens_reverse_resolution')).toBe(true);
	});

	it('verifies false when the name resolves to a different address', async () => {
		const r = await verifyClaim(
			{ identity: 'vitalik.eth', address: OTHER_EVM },
			stubDeps({ resolveEns: async () => VITALIK.toLowerCase() }),
		);
		expect(r.verified).toBe(false);
		expect(r.caveats.length).toBeGreaterThan(0);
	});

	it('is unverifiable (never true) when the name does not resolve', async () => {
		const r = await verifyClaim({ identity: 'ghost.eth', address: VITALIK }, stubDeps());
		expect(r.verified).toBe('unverifiable');
		expect(r.verified).not.toBe(true);
	});
});

describe('SNS claims', () => {
	it('verifies true when the .sol name resolves to the claimed wallet', async () => {
		const r = await verifyClaim(
			{ identity: 'bonfida.sol', address: SOL_WALLET },
			stubDeps({ resolveSns: async () => SOL_WALLET, reverseSns: async () => 'bonfida.sol' }),
		);
		expect(r.verified).toBe(true);
		expect(r.method).toBe('sns-resolution');
	});

	it('is unverifiable when the .sol name does not resolve', async () => {
		const r = await verifyClaim({ identity: 'nope.sol', address: SOL_WALLET }, stubDeps());
		expect(r.verified).toBe('unverifiable');
	});
});

describe('EVM contract control', () => {
	it('verifies true when the deployer matches', async () => {
		const r = await verifyClaim(
			{ identity: VITALIK, address: OTHER_EVM, chain: 'eip155:8453' },
			stubDeps({
				getEvmCode: async () => '0x6080604052',
				getEvmContractCreation: async () => ({ deployer: VITALIK.toLowerCase(), txHash: `0x${'a'.repeat(64)}` }),
			}),
		);
		expect(r.verified).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'evm_deploy_tx')).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'evm_deployer')).toBe(true);
	});

	it('verifies true when owner() matches even without a deployer lookup', async () => {
		const r = await verifyClaim(
			{ identity: VITALIK, address: OTHER_EVM, chain: 'eip155:8453' },
			stubDeps({
				getEvmCode: async () => '0x6080',
				getEvmOwner: async () => VITALIK.toLowerCase(),
			}),
		);
		expect(r.verified).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'evm_owner')).toBe(true);
	});

	it('verifies false when a contract is read but neither deployer nor owner matches', async () => {
		const r = await verifyClaim(
			{ identity: VITALIK, address: OTHER_EVM, chain: 'eip155:8453' },
			stubDeps({
				getEvmCode: async () => '0x6080',
				getEvmContractCreation: async () => ({ deployer: OTHER_EVM, txHash: `0x${'b'.repeat(64)}` }),
				getEvmOwner: async () => OTHER_EVM,
			}),
		);
		expect(r.verified).toBe(false);
	});

	it('is unverifiable for a contract when nothing could be read (no key, no owner)', async () => {
		const r = await verifyClaim(
			{ identity: VITALIK, address: OTHER_EVM, chain: 'eip155:8453' },
			stubDeps({ getEvmCode: async () => '0x6080' }),
		);
		expect(r.verified).toBe('unverifiable');
	});

	it('is unverifiable when the address is an EOA (two distinct wallets cannot be linked)', async () => {
		const r = await verifyClaim(
			{ identity: VITALIK, address: OTHER_EVM, chain: 'eip155:8453' },
			stubDeps({ getEvmCode: async () => '0x' }),
		);
		expect(r.verified).toBe('unverifiable');
	});

	it('verifies true trivially when identity and address are the same account', async () => {
		const r = await verifyClaim({ identity: VITALIK, address: VITALIK }, stubDeps());
		expect(r.verified).toBe(true);
		expect(r.method).toBe('evm-same-address');
	});
});

describe('Solana mint control', () => {
	it('verifies true when the identity is the mint authority', async () => {
		const r = await verifyClaim(
			{ identity: SOL_WALLET, address: SOL_MINT },
			stubDeps({ getSolanaMintInfo: async () => ({ mintAuthority: SOL_WALLET, freezeAuthority: null, updateAuthority: null }) }),
		);
		expect(r.verified).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'solana_mint_authority')).toBe(true);
	});

	it('verifies true when the identity is the metadata update authority', async () => {
		const r = await verifyClaim(
			{ identity: SOL_WALLET, address: SOL_MINT },
			stubDeps({ getSolanaMintInfo: async () => ({ mintAuthority: OTHER_SOL, freezeAuthority: null, updateAuthority: SOL_WALLET }) }),
		);
		expect(r.verified).toBe(true);
	});

	it('verifies false when no authority matches', async () => {
		const r = await verifyClaim(
			{ identity: SOL_WALLET, address: SOL_MINT },
			stubDeps({ getSolanaMintInfo: async () => ({ mintAuthority: OTHER_SOL, freezeAuthority: null, updateAuthority: OTHER_SOL }) }),
		);
		expect(r.verified).toBe(false);
	});

	it('is unverifiable when the address is not a readable mint', async () => {
		const r = await verifyClaim({ identity: SOL_WALLET, address: OTHER_SOL }, stubDeps());
		expect(r.verified).toBe('unverifiable');
	});

	it('is unverifiable when authorities are all renounced', async () => {
		const r = await verifyClaim(
			{ identity: SOL_WALLET, address: SOL_MINT },
			stubDeps({ getSolanaMintInfo: async () => ({ mintAuthority: null, freezeAuthority: null, updateAuthority: null }) }),
		);
		expect(r.verified).toBe('unverifiable');
	});
});

describe('ERC-8004 claims', () => {
	it('verifies true when ownerOf matches the claimed address', async () => {
		const r = await verifyClaim(
			{ identity: 'eip155:8453:42', address: VITALIK },
			stubDeps({ resolveErc8004: async () => ({ owner: VITALIK.toLowerCase(), wallet: null, registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }) }),
		);
		expect(r.verified).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'erc8004_owner_of')).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'erc8004_registration')).toBe(true);
	});

	it('verifies false when the registered owner/wallet differ', async () => {
		const r = await verifyClaim(
			{ identity: 'eip155:8453:42', address: VITALIK },
			stubDeps({ resolveErc8004: async () => ({ owner: OTHER_EVM, wallet: OTHER_EVM }) }),
		);
		expect(r.verified).toBe(false);
	});

	it('is unverifiable when the registry has no record', async () => {
		const r = await verifyClaim({ identity: 'eip155:8453:42', address: VITALIK }, stubDeps());
		expect(r.verified).toBe('unverifiable');
	});
});

describe('three.ws agent_id claims', () => {
	const AGENT = '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55';

	it('verifies true against the canonical deploy record', async () => {
		const r = await verifyClaim(
			{ identity: AGENT, address: SOL_MINT },
			stubDeps({
				lookupThreewsIndex: async () => ({
					sol_mint_address: SOL_MINT,
					onchain: {
						chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
						family: 'solana',
						contract_or_mint: SOL_MINT,
						tx_hash: '4kHTPp9synthetic',
						owner: SOL_WALLET,
						metadata_uri: 'https://arweave.net/synthetic',
						confirmed_at: '2026-04-30T14:08:22Z',
					},
				}),
			}),
		);
		expect(r.verified).toBe(true);
		expect(r.evidence.some((e) => e.kind === 'threews_deploy_tx')).toBe(true);
	});

	it('verifies false when the agent owns a different mint than claimed', async () => {
		const r = await verifyClaim(
			{ identity: AGENT, address: OTHER_SOL },
			stubDeps({
				lookupThreewsIndex: async () => ({
					onchain: { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', contract_or_mint: SOL_MINT, tx_hash: 'x' },
				}),
			}),
		);
		expect(r.verified).toBe(false);
	});

	it('is unverifiable when the agent_id is unknown', async () => {
		const r = await verifyClaim({ identity: AGENT, address: SOL_MINT }, stubDeps());
		expect(r.verified).toBe('unverifiable');
	});
});

describe('no-evidence discipline', () => {
	it('an unclassifiable identity is unverifiable, never true', async () => {
		const r = await verifyClaim({ identity: 'not-an-identity', address: VITALIK }, stubDeps());
		expect(r.verified).toBe('unverifiable');
		expect(r.identity_type).toBe('unknown');
	});

	it('every branch that returns true carries at least one evidence item', async () => {
		const cases = [
			verifyClaim({ identity: 'vitalik.eth', address: VITALIK }, stubDeps({ resolveEns: async () => VITALIK.toLowerCase() })),
			verifyClaim({ identity: SOL_WALLET, address: SOL_MINT }, stubDeps({ getSolanaMintInfo: async () => ({ mintAuthority: SOL_WALLET }) })),
		];
		for (const r of await Promise.all(cases)) {
			if (r.verified === true) expect(r.evidence.length).toBeGreaterThan(0);
		}
	});
});

describe('discovery schema (CDP validation the verify script runs)', () => {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);

	it('bazaar.info validates against bazaar.schema', () => {
		const validate = ajv.compile(BAZAAR.schema);
		const ok = validate(BAZAAR.info);
		if (!ok) console.error(validate.errors);
		expect(ok).toBe(true);
	});

	it('input example validates against the input schema', () => {
		const validate = ajv.compile(INPUT_SCHEMA);
		expect(validate(INPUT_EXAMPLE)).toBe(true);
	});

	it('output example validates against the output schema', () => {
		const validate = ajv.compile(OUTPUT_SCHEMA);
		const ok = validate(OUTPUT_EXAMPLE);
		if (!ok) console.error(validate.errors);
		expect(ok).toBe(true);
	});

	it('a live unverifiable result also validates against the output schema', async () => {
		const validate = ajv.compile(OUTPUT_SCHEMA);
		const r = await verifyClaim({ identity: 'ghost.eth', address: VITALIK }, stubDeps());
		expect(validate(r)).toBe(true);
	});
});
