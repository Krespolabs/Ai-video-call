// api/_lib/pump-swap-ix.js
//
// Builds the raw `data` + `accounts` for the pump bonding-curve
// `buy_exact_quote_in_v2` instruction, intended to be passed to
// `offline.buybackTrigger(...)` via its `swapInstructionData` /
// `remainingAccounts` slots so the outer agent_buyback_trigger CPI invokes a
// real buy before the burn.
//
// We do NOT wrap into a TransactionInstruction; the outer ix consumes the data
// + accounts independently. `user` is the buyback-authority PDA: the outer ix
// signs for it via invoke_signed.
//
// Reference: agent-payments-sdk/src/solana/PumpTradeClient.ts
//   (buildBuyExactQuoteInInstructions — same on-chain ix, but with a human
//   signer + ATA-create prefix we strip for the inner-CPI variant).

import {
	PublicKey,
	SystemProgram,
} from '@solana/web3.js';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	NATIVE_MINT,
	TOKEN_2022_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
	GLOBAL_PDA,
	GLOBAL_VOLUME_ACCUMULATOR_PDA,
	PUMP_EVENT_AUTHORITY_PDA,
	PUMP_FEE_CONFIG_PDA,
	PUMP_FEE_PROGRAM_ID,
	PUMP_PROGRAM_ID,
	PUMP_SDK,
	bondingCurvePda,
	creatorVaultPda,
	feeSharingConfigPda,
	getBuyTokenAmountFromSolAmount,
	userVolumeAccumulatorPda,
} from '@pump-fun/pump-sdk';
import { getBuybackAuthorityPDA } from '@three-ws/agent-payments';

import { getConnection } from './pump.js';

// Anchor discriminator for `buy_exact_quote_in_v2` — see
// agent-payments-sdk/src/solana/idl/pump.json (instruction definition).
const BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR = Buffer.from([
	194, 171, 28, 70, 104, 77, 91, 47,
]);

// Static buyback-fee-recipient pool used as a fallback only. The bonding-curve
// program validates `buyback_fee_recipient` against the live on-chain Global
// config (`global.buybackFeeRecipients`), which is the authoritative source —
// see `pickBuybackFeeRecipient`. This list mirrors `BUYBACK_FEE_RECIPIENTS` in
// agent-payments-sdk/src/solana/constants.ts (not re-exported from the SDK
// index) and docs/pumpfun-program/docs/FEE_RECIPIENTS.md, and is only consulted
// when an older Global account layout omits the field.
const BUYBACK_FEE_RECIPIENTS = [
	'5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
	'9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
	'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
	'3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
	'5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
	'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
	'5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
	'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
].map((s) => new PublicKey(s));

const KNOWN_TOKEN_PROGRAMS = new Set([
	TOKEN_PROGRAM_ID.toBase58(),
	TOKEN_2022_PROGRAM_ID.toBase58(),
]);

function toPubkey(value) {
	if (value instanceof PublicKey) return value;
	return new PublicKey(value);
}

function toBN(value) {
	if (BN.isBN(value)) return value;
	return new BN(value.toString());
}

function resolveQuoteMintFromCurve(quoteMintOnChain) {
	if (!quoteMintOnChain || quoteMintOnChain.equals(PublicKey.default)) {
		return NATIVE_MINT;
	}
	return quoteMintOnChain;
}

function pickRandom(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

function pickFeeRecipient(global, mayhemMode) {
	const pool = mayhemMode
		? [global.reservedFeeRecipient, ...global.reservedFeeRecipients]
		: [global.feeRecipient, ...global.feeRecipients];
	return pickRandom(pool);
}

function pickBuybackFeeRecipient(global) {
	// Prefer the live on-chain list from the decoded Global — the program checks
	// `buyback_fee_recipient` against it, so a rotated/extended set must come from
	// chain, not a vendored constant. Fall back to the static list only when an
	// older Global layout omits `buybackFeeRecipients`.
	const pool =
		global && Array.isArray(global.buybackFeeRecipients) && global.buybackFeeRecipients.length
			? global.buybackFeeRecipients
			: BUYBACK_FEE_RECIPIENTS;
	return pickRandom(pool);
}

/**
 * Build the raw inner-ix data + AccountMeta[] for a pump bonding-curve
 * `buy_exact_quote_in_v2` to be CPI'd by `agent_buyback_trigger`.
 *
 * @param {object} params
 * @param {string|PublicKey} params.mint        Base mint (the agent's token).
 * @param {string|PublicKey} params.currency    Quote currency mint (USDC, etc.).
 *                                              Must equal the curve's quoteMint.
 * @param {BN|bigint|string|number} params.amountIn      Quote units to spend.
 * @param {BN|bigint|string|number|null} [params.minAmountOut]
 *   Explicit floor on base tokens received. If null/undefined, computed from
 *   `slippageBps` against current curve state.
 * @param {number} [params.slippageBps=500]     Used only when minAmountOut is
 *                                              not supplied. Default 5%.
 * @param {'devnet'|'mainnet'|'mainnet-beta'} [params.cluster='mainnet']
 * @param {import('@solana/web3.js').Connection} [params.connection]  Injected
 *   for tests; falls back to `getConnection({ network: <normalized cluster> })`.
 * @returns {Promise<{ data: Buffer, accounts: Array<{ pubkey: PublicKey, isSigner: boolean, isWritable: boolean }>, expectedBaseTokens: BN, minTokensOut: BN }>}
 */
export async function buildPumpSwapInnerIx({
	mint,
	currency,
	amountIn,
	minAmountOut,
	slippageBps,
	cluster = 'mainnet',
	connection: injectedConnection,
}) {
	const mintPk = toPubkey(mint);
	const currencyPk = toPubkey(currency);
	const amountInBn = toBN(amountIn);

	const network = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
	const connection = injectedConnection ?? getConnection({ network });

	const [burnAuthority] = getBuybackAuthorityPDA(mintPk);
	const bcAddr = bondingCurvePda(mintPk);

	const [globalInfo, feeConfigInfo, bcInfo, baseMintInfo, quoteMintInfo] =
		await connection.getMultipleAccountsInfo([
			GLOBAL_PDA,
			PUMP_FEE_CONFIG_PDA,
			bcAddr,
			mintPk,
			currencyPk,
		]);

	if (!globalInfo) {
		throw new Error(
			`pump-swap-ix: Global PDA not found on ${network} — wrong network?`,
		);
	}
	if (!bcInfo) {
		throw new Error(
			`pump-swap-ix: bonding curve not found for mint ${mintPk.toBase58()} on ${network}`,
		);
	}
	if (!baseMintInfo) {
		throw new Error(
			`pump-swap-ix: base mint account ${mintPk.toBase58()} not found on ${network}`,
		);
	}

	const global = PUMP_SDK.decodeGlobal(globalInfo);
	const feeConfig = feeConfigInfo
		? PUMP_SDK.decodeFeeConfig(feeConfigInfo)
		: null;
	const bondingCurve = PUMP_SDK.decodeBondingCurve(bcInfo);

	if (bondingCurve.complete) {
		throw new Error(
			`pump-swap-ix: bonding curve for ${mintPk.toBase58()} has graduated — use AMM instead`,
		);
	}

	const quoteMint = resolveQuoteMintFromCurve(bondingCurve.quoteMint);
	if (!quoteMint.equals(currencyPk)) {
		throw new Error(
			`pump-swap-ix: currency mint mismatch — caller passed ${currencyPk.toBase58()} but curve expects ${quoteMint.toBase58()}`,
		);
	}

	const baseOwner = baseMintInfo.owner;
	if (!KNOWN_TOKEN_PROGRAMS.has(baseOwner.toBase58())) {
		throw new Error(
			`pump-swap-ix: base mint owned by unknown program ${baseOwner.toBase58()}`,
		);
	}
	const baseTokenProgram = baseOwner;

	let quoteTokenProgram;
	if (quoteMint.equals(NATIVE_MINT)) {
		quoteTokenProgram = TOKEN_PROGRAM_ID;
	} else {
		if (!quoteMintInfo) {
			throw new Error(
				`pump-swap-ix: quote mint account ${quoteMint.toBase58()} not found`,
			);
		}
		const quoteOwner = quoteMintInfo.owner;
		if (!KNOWN_TOKEN_PROGRAMS.has(quoteOwner.toBase58())) {
			throw new Error(
				`pump-swap-ix: quote mint owned by unknown program ${quoteOwner.toBase58()}`,
			);
		}
		quoteTokenProgram = quoteOwner;
	}

	const expectedBaseTokens = getBuyTokenAmountFromSolAmount({
		global,
		feeConfig,
		mintSupply: bondingCurve.tokenTotalSupply,
		bondingCurve,
		amount: amountInBn,
		quoteMint,
	});

	if (expectedBaseTokens.lte(new BN(0))) {
		throw new Error(
			`pump-swap-ix: computed expectedBaseTokens=${expectedBaseTokens.toString()} for amountIn=${amountInBn.toString()} — amount too small or reserves exhausted`,
		);
	}

	let minTokensOut;
	if (minAmountOut !== undefined && minAmountOut !== null) {
		minTokensOut = toBN(minAmountOut);
	} else {
		const bps = Number.isFinite(slippageBps) ? Math.max(0, Math.min(10000, slippageBps)) : 500;
		minTokensOut = expectedBaseTokens
			.mul(new BN(10000 - bps))
			.div(new BN(10000));
	}

	const mayhemMode = bondingCurve.isMayhemMode ?? false;
	const feeRecipient = pickFeeRecipient(global, mayhemMode);
	const buybackFeeRecipient = pickBuybackFeeRecipient(global);
	const creatorVault = creatorVaultPda(bondingCurve.creator);
	const userVolAcc = userVolumeAccumulatorPda(burnAuthority);

	const ata = (mintPub, owner, tkProg) =>
		getAssociatedTokenAddressSync(mintPub, owner, true, tkProg);

	// Account list — exact program-required order per IDL definition of
	// `buy_exact_quote_in_v2`. 27 entries. Flags mirror the IDL.
	const accounts = [
		{ pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
		{ pubkey: mintPk, isSigner: false, isWritable: false },
		{ pubkey: quoteMint, isSigner: false, isWritable: false },
		{ pubkey: baseTokenProgram, isSigner: false, isWritable: false },
		{ pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
		{ pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
		{ pubkey: feeRecipient, isSigner: false, isWritable: true },
		{
			pubkey: ata(quoteMint, feeRecipient, quoteTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{ pubkey: buybackFeeRecipient, isSigner: false, isWritable: true },
		{
			pubkey: ata(quoteMint, buybackFeeRecipient, quoteTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{ pubkey: bcAddr, isSigner: false, isWritable: true },
		{
			pubkey: ata(mintPk, bcAddr, baseTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{
			pubkey: ata(quoteMint, bcAddr, quoteTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{ pubkey: burnAuthority, isSigner: true, isWritable: true },
		{
			pubkey: ata(mintPk, burnAuthority, baseTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{
			pubkey: ata(quoteMint, burnAuthority, quoteTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{ pubkey: creatorVault, isSigner: false, isWritable: true },
		{
			pubkey: ata(quoteMint, creatorVault, quoteTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{ pubkey: feeSharingConfigPda(mintPk), isSigner: false, isWritable: false },
		{ pubkey: GLOBAL_VOLUME_ACCUMULATOR_PDA, isSigner: false, isWritable: false },
		{ pubkey: userVolAcc, isSigner: false, isWritable: true },
		{
			pubkey: ata(quoteMint, userVolAcc, quoteTokenProgram),
			isSigner: false,
			isWritable: true,
		},
		{ pubkey: PUMP_FEE_CONFIG_PDA, isSigner: false, isWritable: false },
		{ pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
		{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		{ pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
		{ pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
	];

	const data = Buffer.concat([
		BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR,
		amountInBn.toArrayLike(Buffer, 'le', 8),
		minTokensOut.toArrayLike(Buffer, 'le', 8),
	]);

	return { data, accounts, expectedBaseTokens, minTokensOut };
}

export {
	BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR,
	BUYBACK_FEE_RECIPIENTS,
	PUMP_PROGRAM_ID,
};
