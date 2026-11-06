import { describe, it, expect, vi, beforeEach } from 'vitest';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	NATIVE_MINT,
	TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

// ── Module-level mocks ─────────────────────────────────────────────────────
//
// We mock `@pump-fun/pump-sdk` to control the curve / global decoder return
// values without having to encode synthetic Anchor account buffers. PDAs and
// program-id constants stay real — those are pure functions.

const mockDecodeGlobal = vi.fn();
const mockDecodeFeeConfig = vi.fn();
const mockDecodeBondingCurve = vi.fn();
const mockGetBuyTokenAmount = vi.fn();

vi.mock('@pump-fun/pump-sdk', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		PUMP_SDK: {
			decodeGlobal: (...a) => mockDecodeGlobal(...a),
			decodeFeeConfig: (...a) => mockDecodeFeeConfig(...a),
			decodeBondingCurve: (...a) => mockDecodeBondingCurve(...a),
		},
		getBuyTokenAmountFromSolAmount: (...a) => mockGetBuyTokenAmount(...a),
	};
});

// Import the module under test AFTER the mock registers.
const {
	buildPumpSwapInnerIx,
	BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR,
	BUYBACK_FEE_RECIPIENTS,
	PUMP_PROGRAM_ID,
} = await import('../api/_lib/pump-swap-ix.js');
const {
	GLOBAL_PDA,
	GLOBAL_VOLUME_ACCUMULATOR_PDA,
	PUMP_EVENT_AUTHORITY_PDA,
	PUMP_FEE_CONFIG_PDA,
	PUMP_FEE_PROGRAM_ID,
	bondingCurvePda,
	creatorVaultPda,
	feeSharingConfigPda,
	userVolumeAccumulatorPda,
} = await import('@pump-fun/pump-sdk');
const { getBuybackAuthorityPDA } = await import('@three-ws/agent-payments');

// ── Fixtures ───────────────────────────────────────────────────────────────

// Real-shaped pubkeys so PDA derivations stay deterministic across runs.
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC mainnet — stand-in
const CURRENCY = new PublicKey('So11111111111111111111111111111111111111112'); // wSOL
const CREATOR = new PublicKey('11111111111111111111111111111111');
const FEE_RECIPIENT = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');

function fakeAccountInfo(owner) {
	return {
		owner: owner ?? TOKEN_PROGRAM_ID,
		lamports: 1,
		executable: false,
		rentEpoch: 0,
		data: Buffer.alloc(8),
	};
}

function fakeConnection({ baseOwner = TOKEN_PROGRAM_ID, quoteOwner = TOKEN_PROGRAM_ID } = {}) {
	return {
		getMultipleAccountsInfo: vi.fn(async () => [
			fakeAccountInfo(), // global
			fakeAccountInfo(), // feeConfig
			fakeAccountInfo(), // bondingCurve
			fakeAccountInfo(baseOwner),  // base mint
			fakeAccountInfo(quoteOwner), // quote mint
		]),
	};
}

function setDecodedDefaults() {
	mockDecodeGlobal.mockReturnValue({
		feeRecipient: FEE_RECIPIENT,
		feeRecipients: [],
		reservedFeeRecipient: FEE_RECIPIENT,
		reservedFeeRecipients: [],
	});
	mockDecodeFeeConfig.mockReturnValue(null);
	mockDecodeBondingCurve.mockReturnValue({
		complete: false,
		creator: CREATOR,
		quoteMint: CURRENCY,
		isMayhemMode: false,
		tokenTotalSupply: new BN('1000000000000000'),
		virtualQuoteReserves: new BN('1000000000'),
		virtualTokenReserves: new BN('800000000000000'),
	});
	mockGetBuyTokenAmount.mockReturnValue(new BN('5000000'));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('buildPumpSwapInnerIx', () => {
	beforeEach(() => {
		mockDecodeGlobal.mockReset();
		mockDecodeFeeConfig.mockReset();
		mockDecodeBondingCurve.mockReset();
		mockGetBuyTokenAmount.mockReset();
		setDecodedDefaults();
		// Deterministic random for fee-recipient picks.
		vi.spyOn(Math, 'random').mockReturnValue(0);
	});

	it('returns 24-byte data starting with the buy_exact_quote_in_v2 discriminator', async () => {
		const { data } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: new BN('1000000'),
			minAmountOut: new BN('900000'),
			cluster: 'devnet',
			connection: fakeConnection(),
		});

		expect(data.length).toBe(24);
		const disc = data.subarray(0, 8);
		expect(Buffer.compare(disc, BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR)).toBe(0);
		// Sanity-check the documented byte values too.
		expect(Array.from(disc)).toEqual([194, 171, 28, 70, 104, 77, 91, 47]);
	});

	it('encodes amountIn as u64 LE at byte offset 8', async () => {
		const amountIn = 1234567890n;
		const { data } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn,
			minAmountOut: new BN('0'),
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		expect(data.readBigUInt64LE(8)).toBe(amountIn);
	});

	it('encodes min_tokens_out as u64 LE at byte offset 16 — verbatim when provided', async () => {
		const minOut = 4242424242n;
		const { data, minTokensOut } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 1_000_000n,
			minAmountOut: minOut,
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		expect(data.readBigUInt64LE(16)).toBe(minOut);
		expect(minTokensOut.toString()).toBe(minOut.toString());
	});

	it('derives min_tokens_out from slippageBps when minAmountOut is omitted', async () => {
		// Mocked quote returns 5_000_000. 5% slippage → floor = 4_750_000.
		const { data, minTokensOut } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 1_000_000n,
			slippageBps: 500,
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		expect(data.readBigUInt64LE(16)).toBe(4_750_000n);
		expect(minTokensOut.toString()).toBe('4750000');
	});

	it('returns exactly 27 AccountMeta entries in the program-required order', async () => {
		const { accounts } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 1_000_000n,
			minAmountOut: 0n,
			cluster: 'devnet',
			connection: fakeConnection(),
		});

		expect(accounts).toHaveLength(27);

		const bcAddr = bondingCurvePda(MINT);
		const [burnAuthority] = getBuybackAuthorityPDA(MINT);
		const burnMintVault = getAssociatedTokenAddressSync(MINT, burnAuthority, true, TOKEN_PROGRAM_ID);
		const burnCurrencyMintVault = getAssociatedTokenAddressSync(CURRENCY, burnAuthority, true, TOKEN_PROGRAM_ID);
		const userVolAcc = userVolumeAccumulatorPda(burnAuthority);

		// Index-by-index key positions per IDL.
		expect(accounts[0].pubkey.equals(GLOBAL_PDA)).toBe(true);
		expect(accounts[1].pubkey.equals(MINT)).toBe(true);
		expect(accounts[2].pubkey.equals(CURRENCY)).toBe(true);
		expect(accounts[3].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
		expect(accounts[4].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
		expect(accounts[5].pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
		expect(accounts[6].pubkey.equals(FEE_RECIPIENT)).toBe(true);
		expect(accounts[10].pubkey.equals(bcAddr)).toBe(true);
		expect(accounts[13].pubkey.equals(burnAuthority)).toBe(true);
		expect(accounts[14].pubkey.equals(burnMintVault)).toBe(true);
		expect(accounts[15].pubkey.equals(burnCurrencyMintVault)).toBe(true);
		expect(accounts[16].pubkey.equals(creatorVaultPda(CREATOR))).toBe(true);
		expect(accounts[18].pubkey.equals(feeSharingConfigPda(MINT))).toBe(true);
		expect(accounts[19].pubkey.equals(GLOBAL_VOLUME_ACCUMULATOR_PDA)).toBe(true);
		expect(accounts[20].pubkey.equals(userVolAcc)).toBe(true);
		expect(accounts[22].pubkey.equals(PUMP_FEE_CONFIG_PDA)).toBe(true);
		expect(accounts[23].pubkey.equals(PUMP_FEE_PROGRAM_ID)).toBe(true);
		expect(accounts[25].pubkey.equals(PUMP_EVENT_AUTHORITY_PDA)).toBe(true);
		expect(accounts[26].pubkey.equals(PUMP_PROGRAM_ID)).toBe(true);
	});

	it('marks `user` (burn-authority PDA) as signer + writable; mints as read-only', async () => {
		const { accounts } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 1_000_000n,
			minAmountOut: 0n,
			cluster: 'devnet',
			connection: fakeConnection(),
		});

		// user (index 13) — outer ix invoke_signed supplies the PDA signature.
		expect(accounts[13].isSigner).toBe(true);
		expect(accounts[13].isWritable).toBe(true);
		// base/quote mint reads (1, 2) — non-writable.
		expect(accounts[1].isWritable).toBe(false);
		expect(accounts[2].isWritable).toBe(false);
		// Bonding curve, vaults — all writable.
		expect(accounts[10].isWritable).toBe(true);
		expect(accounts[14].isWritable).toBe(true);
		expect(accounts[15].isWritable).toBe(true);
	});

	it('exact writable mask matches the IDL', async () => {
		const { accounts } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 1_000_000n,
			minAmountOut: 0n,
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		// Writable indices per `buy_exact_quote_in_v2` IDL:
		const writableSet = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21]);
		accounts.forEach((acct, i) => {
			expect(acct.isWritable, `account ${i} writable flag`).toBe(writableSet.has(i));
		});
		// `user` (13) is the only signer — invoke_signed by the outer ix.
		const signerIdxs = accounts
			.map((a, i) => (a.isSigner ? i : -1))
			.filter((i) => i >= 0);
		expect(signerIdxs).toEqual([13]);
	});

	it('selects the buyback fee recipient from on-chain global.buybackFeeRecipients when present', async () => {
		// The program validates `buyback_fee_recipient` against the live Global
		// config, so a single-entry on-chain list must win over the static fallback.
		const onchainBuyback = new PublicKey('3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR');
		mockDecodeGlobal.mockReturnValueOnce({
			feeRecipient: FEE_RECIPIENT,
			feeRecipients: [],
			reservedFeeRecipient: FEE_RECIPIENT,
			reservedFeeRecipients: [],
			buybackFeeRecipients: [onchainBuyback],
		});
		const { accounts } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 1_000_000n,
			minAmountOut: 0n,
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		// account 8 (0-based) = buyback_fee_recipient per the buy_exact_quote_in_v2 IDL.
		expect(accounts[8].pubkey.equals(onchainBuyback)).toBe(true);
		// account 9 = its associated quote ATA, owned by that same recipient.
		const expectedAta = getAssociatedTokenAddressSync(CURRENCY, onchainBuyback, true, TOKEN_PROGRAM_ID);
		expect(accounts[9].pubkey.equals(expectedAta)).toBe(true);
	});

	it('falls back to the static buyback list when global omits buybackFeeRecipients', async () => {
		// setDecodedDefaults() (beforeEach) provides no buybackFeeRecipients and
		// Math.random is pinned to 0, so the fallback picks BUYBACK_FEE_RECIPIENTS[0].
		const { accounts } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 1_000_000n,
			minAmountOut: 0n,
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		expect(accounts[8].pubkey.equals(BUYBACK_FEE_RECIPIENTS[0])).toBe(true);
	});

	it('throws when the bonding curve has graduated', async () => {
		mockDecodeBondingCurve.mockReturnValueOnce({
			complete: true,
			creator: CREATOR,
			quoteMint: CURRENCY,
			isMayhemMode: false,
			tokenTotalSupply: new BN('1'),
			virtualQuoteReserves: new BN('1'),
			virtualTokenReserves: new BN('1'),
		});
		await expect(
			buildPumpSwapInnerIx({
				mint: MINT,
				currency: CURRENCY,
				amountIn: 1_000_000n,
				minAmountOut: 0n,
				cluster: 'devnet',
				connection: fakeConnection(),
			}),
		).rejects.toThrow(/graduated/i);
	});

	it('throws when the caller-supplied currency does not match the curve quote mint', async () => {
		const wrongCurrency = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'); // some other mint
		await expect(
			buildPumpSwapInnerIx({
				mint: MINT,
				currency: wrongCurrency,
				amountIn: 1_000_000n,
				minAmountOut: 0n,
				cluster: 'devnet',
				connection: fakeConnection(),
			}),
		).rejects.toThrow(/currency mint mismatch/i);
	});

	it('normalizes legacy quote-mint default (PublicKey.default) to NATIVE_MINT', async () => {
		mockDecodeBondingCurve.mockReturnValueOnce({
			complete: false,
			creator: CREATOR,
			quoteMint: PublicKey.default,
			isMayhemMode: false,
			tokenTotalSupply: new BN('1000000'),
			virtualQuoteReserves: new BN('1'),
			virtualTokenReserves: new BN('1'),
		});
		const { accounts } = await buildPumpSwapInnerIx({
			mint: MINT,
			currency: NATIVE_MINT,
			amountIn: 1_000_000n,
			minAmountOut: 0n,
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		// quote_mint slot (index 2) resolves to NATIVE_MINT.
		expect(accounts[2].pubkey.equals(NATIVE_MINT)).toBe(true);
	});

	it('passes amountIn through to the quote helper as a BN', async () => {
		await buildPumpSwapInnerIx({
			mint: MINT,
			currency: CURRENCY,
			amountIn: 9_999_999n,
			slippageBps: 1000,
			cluster: 'devnet',
			connection: fakeConnection(),
		});
		expect(mockGetBuyTokenAmount).toHaveBeenCalledOnce();
		const call = mockGetBuyTokenAmount.mock.calls[0][0];
		expect(call.amount.toString()).toBe('9999999');
		expect(call.quoteMint.equals(CURRENCY)).toBe(true);
	});
});
