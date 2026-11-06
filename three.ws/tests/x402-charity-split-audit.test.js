import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';

// Pure-logic integration test for the Charity Split Audit pipeline. The split
// arithmetic, the broken-merchant-config classifier, and the on-chain transfer
// collector are the giving-integrity heart of "ensures donation promises are
// kept" — exercise them with no DB and no chain.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const {
	computeSplit,
	isValidAddress,
	classifyCharityConfig,
	collectTokenTransfers,
} = await import('../api/_lib/x402/pipelines/charity-split-audit.js');

const solAddr = () => Keypair.generate().publicKey.toBase58();
const EVM = '0x1111111111111111111111111111111111111111';

describe('computeSplit — floor(amount × bps / 10000)', () => {
	it('matches the checkout tip math exactly at the atom', () => {
		expect(computeSplit(1000, 500)).toBe(50n); // $0.001 @ 5%
		expect(computeSplit(1_000_000, 250)).toBe(25_000n); // $1.00 @ 2.5%
		expect(computeSplit(1_000_000, 10000)).toBe(1_000_000n); // 100%
	});
	it('floors rather than rounds — never overpays the cause', () => {
		// 999 × 5% = 49.95 → 49, not 50.
		expect(computeSplit(999, 500)).toBe(49n);
		// A share too small for the base rounds the split to zero.
		expect(computeSplit(100, 1)).toBe(0n);
	});
});

describe('isValidAddress — chain-matched', () => {
	it('accepts a base58 address only on solana', () => {
		const a = solAddr();
		expect(isValidAddress('solana', a)).toBe(true);
		expect(isValidAddress('base', a)).toBe(false);
	});
	it('accepts a 0x address only on base', () => {
		expect(isValidAddress('base', EVM)).toBe(true);
		expect(isValidAddress('solana', EVM)).toBe(false);
	});
	it('rejects empty / unknown chain', () => {
		expect(isValidAddress('solana', '')).toBe(false);
		expect(isValidAddress(null, solAddr())).toBe(false);
	});
});

describe('classifyCharityConfig — broken donation promises', () => {
	const validSol = () => ({
		owner_user_id: 'u1',
		charity_chain: 'solana',
		charity_address: solAddr(),
		charity_bps: 500,
		payout_solana: solAddr(),
		payout_evm: null,
	});

	it('passes a fully-configured solana charity', () => {
		const c = classifyCharityConfig(validSol());
		expect(c.configValid).toBe(true);
		expect(c.reason).toBeNull();
		expect(c.expectedSplitAtomic).toBe(50_000); // $1.00 @ 5%
	});

	it('flags a missing cause address', () => {
		const c = classifyCharityConfig({ ...validSol(), charity_address: null });
		expect(c.configValid).toBe(false);
		expect(c.reason).toBe('missing_charity_address');
		expect(c.expectedSplitAtomic).toBeNull();
	});

	it('flags a cause address that does not match its chain', () => {
		const c = classifyCharityConfig({ ...validSol(), charity_address: EVM });
		expect(c.reason).toBe('invalid_solana_charity_address');
	});

	it('flags a zero share', () => {
		const c = classifyCharityConfig({ ...validSol(), charity_bps: 0 });
		expect(c.reason).toBe('zero_bps');
	});

	it('flags a share over 100%', () => {
		const c = classifyCharityConfig({ ...validSol(), charity_bps: 10001 });
		expect(c.reason).toBe('bps_over_100pct');
	});

	it('flags a missing payout (nowhere for the base payment to land)', () => {
		const c = classifyCharityConfig({ ...validSol(), payout_solana: null });
		expect(c.reason).toBe('missing_payout');
	});

	it('flags cause == payout — the tip the checkout silently drops', () => {
		const shared = solAddr();
		const c = classifyCharityConfig({
			...validSol(),
			charity_address: shared,
			payout_solana: shared,
		});
		expect(c.reason).toBe('charity_equals_payout');
	});

	it('picks the chain-correct payout column', () => {
		const c = classifyCharityConfig({
			owner_user_id: 'u2',
			charity_chain: 'base',
			charity_address: EVM,
			charity_bps: 100,
			payout_evm: '0x2222222222222222222222222222222222222222',
			payout_solana: solAddr(),
		});
		expect(c.configValid).toBe(true);
		expect(c.payout).toBe('0x2222222222222222222222222222222222222222');
	});
});

describe('collectTokenTransfers — on-chain verification', () => {
	const charityAta = solAddr();
	const payToAta = solAddr();

	function parsedTx({ withCharity = true } = {}) {
		const ixs = [
			{
				program: 'spl-token',
				parsed: { type: 'transferChecked', info: { destination: payToAta, tokenAmount: { amount: '1000' } } },
			},
		];
		if (withCharity) {
			ixs.push({
				program: 'spl-token',
				parsed: { type: 'transferChecked', info: { destination: charityAta, tokenAmount: { amount: '50' } } },
			});
		}
		return { transaction: { message: { instructions: ixs } }, meta: { innerInstructions: [] } };
	}

	it('finds both the base and charity legs with exact atomics', () => {
		const legs = collectTokenTransfers(parsedTx());
		expect(legs).toContainEqual({ destination: payToAta, amount: '1000' });
		expect(legs).toContainEqual({ destination: charityAta, amount: '50' });
	});

	it('omits the charity leg when it was never appended (regression signal)', () => {
		const legs = collectTokenTransfers(parsedTx({ withCharity: false }));
		expect(legs.some((l) => l.destination === charityAta)).toBe(false);
	});

	it('collects legs from inner instructions too', () => {
		const tx = {
			transaction: { message: { instructions: [] } },
			meta: {
				innerInstructions: [
					{ instructions: [{ program: 'spl-token', parsed: { type: 'transfer', info: { destination: charityAta, amount: '50' } } }] },
				],
			},
		};
		expect(collectTokenTransfers(tx)).toContainEqual({ destination: charityAta, amount: '50' });
	});

	it('ignores non-token-transfer instructions', () => {
		const tx = {
			transaction: { message: { instructions: [
				{ program: 'system', parsed: { type: 'createAccount', info: {} } },
				{ program: 'spl-token', parsed: { type: 'initializeAccount', info: { account: charityAta } } },
			] } },
			meta: { innerInstructions: [] },
		};
		expect(collectTokenTransfers(tx)).toEqual([]);
	});
});
