import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Mock the on-chain send and the provenance write so the settlement DECISION
// logic (split, caps, payout gating, honest no-pay reasons) is tested in
// isolation — no chain, no DB. The pure split math is exercised directly in
// tests/remix-royalty.test.js; here we assert the leg that decides whether and
// how much to actually pay, and that it records provenance when it does.
const transferMock = vi.fn(async () => 'SIGipfsMockTx1111111111111111111111111111');
const recordMock = vi.fn(async () => true);

vi.mock('../api/_lib/solana-transfer.js', () => ({ transferSolanaUSDC: transferMock }));
vi.mock('../api/_lib/forge-store.js', () => ({ recordRemixSettlement: recordMock }));

const { settleRemixRoyalty, royaltyPayoutConfigured } = await import('../api/_lib/remix-settlement.js');

// A valid Base58 Solana address for the creator wallet, and a valid 64-byte
// Base58 secret for the platform payout wallet.
const CREATOR = Keypair.generate().publicKey.toBase58();
const PAYOUT_SECRET = bs58.encode(Keypair.generate().secretKey);

function source(overrides = {}) {
	return { id: 'src-1', prompt: 'a round robot mascot', creatorWallet: CREATOR, royaltyBps: 1000, ...overrides };
}

describe('settleRemixRoyalty', () => {
	beforeEach(() => {
		transferMock.mockClear();
		recordMock.mockClear();
		process.env.REMIX_ROYALTY_PAYOUT_KEY = PAYOUT_SECRET;
	});
	afterEach(() => {
		delete process.env.REMIX_ROYALTY_PAYOUT_KEY;
		delete process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
	});

	it('pays the creator their royalty and records provenance', async () => {
		// 1 USDC fee, 10% royalty → 0.1 USDC to the creator, 0.9 to the platform.
		const r = await settleRemixRoyalty({ source: source(), priceAtomics: 1_000_000n, remixCreationId: 'remix-1' });
		expect(r.paid).toBe(true);
		expect(r.creatorAtomics).toBe('100000');
		expect(r.platformAtomics).toBe('900000');
		expect(r.creatorTx).toBe('SIGipfsMockTx1111111111111111111111111111');
		// The on-chain send got exactly the creator's atomic amount, to the creator.
		expect(transferMock).toHaveBeenCalledTimes(1);
		const call = transferMock.mock.calls[0][0];
		expect(call.toAddress).toBe(CREATOR);
		expect(call.amount).toBe(100000n);
		// Provenance recorded on the SOURCE with the tx + the remix that triggered it.
		expect(recordMock).toHaveBeenCalledTimes(1);
		const rec = recordMock.mock.calls[0][0];
		expect(rec.sourceCreationId).toBe('src-1');
		expect(rec.settlement.tx_signature).toBe(r.creatorTx);
		expect(rec.settlement.remix_creation_id).toBe('remix-1');
		expect(rec.settlement.usdc_atomics).toBe('100000');
	});

	it('caps a greedy royalty rate at 20% — remixer keeps the majority', async () => {
		// A source asking 50% is clamped to the 20% policy cap.
		const r = await settleRemixRoyalty({ source: source({ royaltyBps: 5000 }), priceAtomics: 1_000_000n });
		expect(r.capped).toBe(true);
		expect(r.royaltyBps).toBe(2000);
		expect(r.creatorAtomics).toBe('200000'); // 20%, not 50%
		expect(r.platformAtomics).toBe('800000');
		// Value is conserved: creator + platform === fee.
		expect(BigInt(r.creatorAtomics) + BigInt(r.platformAtomics)).toBe(1_000_000n);
	});

	it('does not pay when the source has no payout wallet', async () => {
		const r = await settleRemixRoyalty({ source: source({ creatorWallet: null }), priceAtomics: 1_000_000n });
		expect(r.paid).toBe(false);
		expect(r.reason).toBe('no_creator_wallet');
		expect(transferMock).not.toHaveBeenCalled();
		expect(recordMock).not.toHaveBeenCalled();
	});

	it('does not pay a sub-dust royalty (records why, never a fake pending)', async () => {
		// 0.05 USDC fee at 10% = 5000 atomics, below the 10000 dust floor.
		const r = await settleRemixRoyalty({ source: source(), priceAtomics: 50_000n });
		expect(r.paid).toBe(false);
		expect(r.reason).toBe('below_dust_floor');
		expect(r.dust).toBe(true);
		// The platform keeps the whole fee when the royalty is dust.
		expect(r.platformAtomics).toBe('50000');
		expect(transferMock).not.toHaveBeenCalled();
	});

	it('does not pay when the platform payout wallet is unconfigured', async () => {
		delete process.env.REMIX_ROYALTY_PAYOUT_KEY;
		expect(royaltyPayoutConfigured()).toBe(false);
		const r = await settleRemixRoyalty({ source: source(), priceAtomics: 1_000_000n });
		expect(r.paid).toBe(false);
		expect(r.reason).toBe('payout_unconfigured');
		expect(transferMock).not.toHaveBeenCalled();
	});

	it('reports payout as configured when a valid key is present', () => {
		expect(royaltyPayoutConfigured()).toBe(true);
	});
});
