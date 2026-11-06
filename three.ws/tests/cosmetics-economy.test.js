// Coverage for the R25 cosmetic creator-revenue-split economy
// (api/_lib/cosmetics-economy.js):
//
//   • split config: clamp to the platform ceiling + the exact signed message
//   • recordSaleAndSplit: the creator-cut math, idempotency on (account,cosmetic),
//     the REAL on-chain payout call, and fail-open behaviour when untied
//   • setSplitConfig: signature-gated, creator-only authorization
//   • leaderboard: rarity-weighted scarcity ordering
//
// The Neon `sql` tag, the Solana USDC transfer, and the ed25519 verify are mocked
// so the money path is exercised deterministically without a DB or a funded wallet
// (the on-chain transfer itself is verified against the real rail on deploy).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── mocks ────────────────────────────────────────────────────────────────────

// A tiny tagged-template `sql` stand-in: tests push handlers that return rows. FIFO.
const sqlCalls = [];
let sqlHandlers = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = strings.join('?').replace(/\s+/g, ' ').trim();
		sqlCalls.push({ text, values });
		const h = sqlHandlers.shift();
		return Promise.resolve(h ? h(text, values) : []);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const transferMock = vi.fn();
vi.mock('../api/_lib/solana-transfer.js', () => ({
	transferSolanaUSDC: (...args) => transferMock(...args),
}));

let sigValid = true;
vi.mock('../api/_lib/siws.js', () => ({ verifySiwsSignature: () => sigValid }));

// Coin lookup miss by default so config falls through to the explicit override path.
vi.mock('../api/_lib/coin/index.js', () => ({ loadCoinByMint: async () => null }));

// Neutralize the on-chain pump.fun creator fallback so resolution is deterministic
// (no live RPC): an account-info miss makes resolveOnchainPumpCreator return null.
vi.mock('../api/_lib/pump.js', () => ({
	getConnection: () => ({ getAccountInfo: async () => null }),
}));

const {
	clampCreatorBps, splitConfigMessage, recordSaleAndSplit, setSplitConfig,
	cosmeticsLeaderboard, MAX_CREATOR_BPS, DEFAULT_CREATOR_BPS,
} = await import('../api/_lib/cosmetics-economy.js');

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const CREATOR = 'WwW9dwK7iY5cT9aZ8h6n3v2Q1rT4uYpL5mN6oP7qR8s';
const BUYER = '8h6n3v2Q1rT4uYpL5mN6oP7qR8sWwW9dwK7iY5cT9aZ';

beforeEach(() => {
	sqlCalls.length = 0;
	sqlHandlers = [];
	transferMock.mockReset();
	sigValid = true;
	process.env.DATABASE_URL = 'postgres://test';
	process.env.COSMETIC_SPLIT_TREASURY_SECRET_KEY_B64 = Buffer.alloc(64, 7).toString('base64');
});

describe('split config bounds + message', () => {
	it('clamps the creator share to the platform ceiling', () => {
		expect(clampCreatorBps(99999)).toBe(MAX_CREATOR_BPS);
		expect(clampCreatorBps(-5)).toBe(0);
		expect(clampCreatorBps(3000)).toBe(3000);
		expect(clampCreatorBps('nope')).toBe(DEFAULT_CREATOR_BPS);
	});

	it('binds the signed message to the mint + bps + timestamp', () => {
		const msg = splitConfigMessage({ mint: MINT, bps: 5000, ts: 1700000000 });
		expect(msg).toContain(MINT);
		expect(msg).toContain('5000 bps');
		expect(msg).toContain('1700000000');
	});
});

describe('recordSaleAndSplit — creator cut + payout', () => {
	it('computes the creator cut, records it, and pays out on-chain', async () => {
		sqlHandlers.push(() => [{ mint: MINT, creator_wallet: CREATOR, split_bps: 6000, updated_at: null }]); // getSplitConfig
		sqlHandlers.push(() => [{ id: 'sale-1' }]); // insert sale
		sqlHandlers.push(() => []); // markPayout update
		transferMock.mockResolvedValue('payout-sig-123');

		const out = await recordSaleAndSplit({
			account: BUYER, cosmeticId: 'skin-midnight', payerWallet: BUYER,
			payerNetwork: 'solana', asset: 'USDC', priceAtomics: '3000000', mint: MINT,
		});

		expect(out.recorded).toBe(true);
		expect(out.creatorWallet).toBe(CREATOR);
		expect(out.creatorBps).toBe(6000);
		expect(out.creatorCutAtomics).toBe('1800000'); // 60% of 3,000,000
		expect(out.payoutStatus).toBe('paid');
		expect(out.payoutTx).toBe('payout-sig-123');
		expect(transferMock).toHaveBeenCalledTimes(1);
		const arg = transferMock.mock.calls[0][0];
		expect(arg.toAddress).toBe(CREATOR);
		expect(String(arg.amount)).toBe('1800000');
	});

	it('is idempotent: a conflicting (already-recorded) sale never re-pays', async () => {
		sqlHandlers.push(() => [{ mint: MINT, creator_wallet: CREATOR, split_bps: 5000, updated_at: null }]);
		sqlHandlers.push(() => []); // insert → conflict, no row returned
		const out = await recordSaleAndSplit({
			account: BUYER, cosmeticId: 'skin-midnight', payerWallet: BUYER,
			payerNetwork: 'solana', asset: 'USDC', priceAtomics: '3000000', mint: MINT,
		});
		expect(out).toEqual({ recorded: true, alreadyRecorded: true });
		expect(transferMock).not.toHaveBeenCalled();
	});

	it('records an untied sale (no coin) with no creator leg or payout', async () => {
		sqlHandlers.push(() => [{ id: 'sale-2' }]); // insert only
		const out = await recordSaleAndSplit({
			account: BUYER, cosmeticId: 'skin-midnight', payerWallet: BUYER,
			payerNetwork: 'base', asset: 'USDC', priceAtomics: '3000000', mint: null,
		});
		expect(out.recorded).toBe(true);
		expect(out.creatorWallet).toBeNull();
		expect(transferMock).not.toHaveBeenCalled();
	});

	it('never pays a creator out of their own purchase', async () => {
		sqlHandlers.push(() => [{ mint: MINT, creator_wallet: CREATOR, split_bps: 5000, updated_at: null }]);
		sqlHandlers.push(() => [{ id: 'sale-3' }]);
		const out = await recordSaleAndSplit({
			account: CREATOR, cosmeticId: 'skin-midnight', payerWallet: CREATOR,
			payerNetwork: 'solana', asset: 'USDC', priceAtomics: '3000000', mint: MINT,
		});
		expect(out.creatorWallet).toBeNull();
		expect(transferMock).not.toHaveBeenCalled();
	});
});

describe('setSplitConfig — authorization', () => {
	it('rejects when no creator can be established for the coin', async () => {
		sqlHandlers.push(() => []); // resolveCreatorWallet: config miss
		sqlHandlers.push(() => []); // agent_identities miss (coin/index + pump mocked empty)
		await expect(setSplitConfig({
			mint: MINT, bps: 4000, ts: Math.floor(Date.now() / 1000), signature: 'sig', signer: BUYER,
		})).rejects.toMatchObject({ code: 'no_creator' });
	});

	it('accepts a valid signature from the creator and upserts the share', async () => {
		sqlHandlers.push(() => [{ creator_wallet: CREATOR }]); // resolveCreatorWallet → config override
		sqlHandlers.push(() => []); // upsert
		sqlHandlers.push(() => [{ mint: MINT, creator_wallet: CREATOR, split_bps: 4000, updated_at: new Date().toISOString() }]); // read-back
		sigValid = true;
		const cfg = await setSplitConfig({
			mint: MINT, bps: 4000, ts: Math.floor(Date.now() / 1000), signature: 'good', signer: CREATOR,
		});
		expect(cfg.splitBps).toBe(4000);
		expect(cfg.creatorWallet).toBe(CREATOR);
	});

	it('rejects a bad signature', async () => {
		sqlHandlers.push(() => [{ creator_wallet: CREATOR }]); // resolve → creator
		sigValid = false;
		await expect(setSplitConfig({
			mint: MINT, bps: 4000, ts: Math.floor(Date.now() / 1000), signature: 'bad', signer: CREATOR,
		})).rejects.toMatchObject({ code: 'bad_signature' });
	});
});

describe('cosmeticsLeaderboard — rarest fits ordering', () => {
	it('ranks scarcer fits first and tallies flex scores', async () => {
		sqlHandlers.push(() => [
			{ cosmetic_id: 'skin-midnight', account: BUYER, any_mint: MINT },   // legendary, 1 owner
			{ cosmetic_id: 'skin-crimson', account: BUYER, any_mint: MINT },    // rare
			{ cosmetic_id: 'skin-crimson', account: CREATOR, any_mint: MINT },  // rare, 2 owners total
		]);
		sqlHandlers.push(() => []); // topCreators
		sqlHandlers.push(() => []); // recent
		const board = await cosmeticsLeaderboard({ limit: 12 });
		expect(board.rarestFits[0].cosmeticId).toBe('skin-midnight');
		expect(board.rarestFits[0].owners).toBe(1);
		expect(board.rarestFits[1].cosmeticId).toBe('skin-crimson');
		expect(board.rarestFits[1].owners).toBe(2);
		const top = board.topCollectors.find((c) => c.account === BUYER);
		expect(top.flexScore).toBe(44); // legendary(40) + rare(4)
		expect(top.fits).toBe(2);
	});
});
