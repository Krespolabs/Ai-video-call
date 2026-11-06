// @ts-check
// On-chain primitives for the Fee Bridge: read a coin's fee-sharing state, and
// send transactions exactly once.
//
// Exactly-once sending: the caller persists a transaction's signature and
// blockhash BEFORE it is broadcast. If the process dies after that, the next tick
// asks the chain what happened (resolveTracked): landed, reverted, still pending,
// or dropped because its blockhash expired without it landing. Only a dropped or
// reverted transaction is ever rebuilt, so no swap, payout, or crank can be sent
// twice.

import {
	ComputeBudgetProgram,
	PublicKey,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

import { getConnection, getPumpSdkV2 } from '../pump.js';
import { confirmOrThrow } from '../solana/confirm.js';
import { tokenProgramIdForMint } from '../token/token-program.js';
import { NATIVE_SOL_MINT, SUPPORTED_QUOTE_MINTS } from './config.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PRIORITY_MICRO_LAMPORTS = 100_000;

export function connection() {
	return getConnection({ network: 'mainnet' });
}

/** Base58 signature of a signed transaction (its first signature). */
export function signatureOf(tx) {
	const sig = tx.signatures?.[0];
	if (!sig) throw new Error('transaction is not signed');
	return bs58.encode(sig);
}

/**
 * Build and sign a v0 transaction paid by `signer`.
 * @param {import('@solana/web3.js').Keypair} signer
 * @param {TransactionInstruction[]} instructions
 */
export async function buildSigned(signer, instructions) {
	const conn = connection();
	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	const message = new TransactionMessage({
		payerKey: signer.publicKey,
		recentBlockhash: blockhash,
		instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }), ...instructions],
	}).compileToV0Message();
	const tx = new VersionedTransaction(message);
	tx.sign([signer]);
	return { tx, signature: signatureOf(tx), blockhash };
}

/**
 * Sign a pre-built transaction (a Jupiter swap) and read its identity.
 * @param {import('@solana/web3.js').Keypair} signer
 * @param {string} base64
 */
export function signPrebuilt(signer, base64) {
	const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
	tx.sign([signer]);
	return { tx, signature: signatureOf(tx), blockhash: tx.message.recentBlockhash };
}

/**
 * Broadcast an already-persisted transaction and wait for it. Throws on revert or
 * timeout; either way the persisted signature is what the resolver checks next.
 * @param {VersionedTransaction} tx
 * @param {string} signature
 */
export async function broadcast(tx, signature) {
	const conn = connection();
	await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
	await confirmOrThrow(conn, signature, 'confirmed', { timeoutMs: 60_000 });
	return signature;
}

/**
 * What became of a persisted transaction.
 * @param {string} signature
 * @param {string} blockhash
 * @returns {Promise<'landed'|'reverted'|'pending'|'dropped'>}
 */
export async function resolveTracked(signature, blockhash) {
	const conn = connection();
	const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
	const st = value?.[0];
	if (st) {
		if (st.err) return 'reverted';
		if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'landed';
		return 'pending';
	}
	// Unknown to the cluster. While its blockhash is still valid it may yet land;
	// once the blockhash has expired it never can.
	const valid = await conn.isBlockhashValid(blockhash, { commitment: 'confirmed' });
	return valid.value ? 'pending' : 'dropped';
}

/** Landed transaction meta, retried briefly because RPCs index a moment behind confirmation. */
export async function landedMeta(signature) {
	const conn = connection();
	for (let i = 0; i < 6; i++) {
		const tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
		if (tx?.meta) {
			const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
			return { meta: tx.meta, accountKeys: keys.staticAccountKeys.map((k) => k.toBase58()) };
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	throw Object.assign(new Error(`transaction ${signature} confirmed but its details are not yet available`), {
		code: 'meta_unavailable',
	});
}

/**
 * A coin's creator-fee routing as it stands on chain.
 * @param {string} mint
 * @returns {Promise<{ exists: boolean, quoteMint: string, supportedQuote: boolean, hasSharingConfig: boolean, admin: string|null, adminRevoked: boolean, shareholders: Array<{ address: string, bps: number }> }>}
 */
export async function readSharingState(mint) {
	const conn = connection();
	const mintPk = new PublicKey(mint);
	const [{ OnlinePumpSdk, PumpSdk, feeSharingConfigPda }, v2] = await Promise.all([
		import('@pump-fun/pump-sdk'),
		getPumpSdkV2({ network: 'mainnet' }),
	]);
	const online = new OnlinePumpSdk(conn);
	const bc = await online.fetchBondingCurve(mintPk).catch(() => null);
	if (!bc) {
		return { exists: false, quoteMint: NATIVE_SOL_MINT, supportedQuote: false, hasSharingConfig: false, admin: null, adminRevoked: false, shareholders: [] };
	}
	const rawQuote = /** @type {any} */ (bc).quoteMint;
	const quoteMint = rawQuote && !v2.isLegacyQuoteMint(rawQuote) ? rawQuote.toBase58() : NATIVE_SOL_MINT;

	const cfgInfo = await conn.getAccountInfo(feeSharingConfigPda(mintPk));
	if (!cfgInfo) {
		return { exists: true, quoteMint, supportedQuote: SUPPORTED_QUOTE_MINTS.has(quoteMint), hasSharingConfig: false, admin: null, adminRevoked: false, shareholders: [] };
	}
	const cfg = new PumpSdk().decodeSharingConfig(cfgInfo);
	return {
		exists: true,
		quoteMint,
		supportedQuote: SUPPORTED_QUOTE_MINTS.has(quoteMint),
		hasSharingConfig: true,
		admin: cfg.admin.toBase58(),
		adminRevoked: !!cfg.adminRevoked,
		shareholders: cfg.shareholders.map((s) => ({ address: s.address.toBase58(), bps: Number(s.shareBps) })),
	};
}

/** True when the bridge is the one and only shareholder, at 100%. */
export function routesOnlyTo(state, bridge) {
	return (
		state.hasSharingConfig &&
		state.shareholders.length === 1 &&
		state.shareholders[0].address === bridge &&
		state.shareholders[0].bps === 10_000
	);
}

/**
 * Whether a coin has enough accrued fees to distribute, and the instructions to do it.
 * @param {string} mint
 * @param {string} quoteMint
 * @param {PublicKey} payer
 */
export async function planDistribution(mint, quoteMint, payer) {
	const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
	const online = new OnlinePumpSdk(connection());
	const mintPk = new PublicKey(mint);
	const quotePk = new PublicKey(quoteMint);
	const min = await online.getMinimumDistributableFee(mintPk, payer, { quoteMint: quotePk, payer });
	if (!min.canDistribute) {
		return { canDistribute: false, distributable: BigInt(min.distributableFees?.toString?.() ?? '0'), instructions: [] };
	}
	const { instructions } = await online.buildDistributeCreatorFeesInstructions(mintPk, { quoteMint: quotePk, payer });
	return { canDistribute: true, distributable: BigInt(min.distributableFees?.toString?.() ?? '0'), instructions };
}

/**
 * Instructions for an SPL transfer to `owner`, creating their token account when needed.
 * @param {object} a
 * @param {PublicKey} a.from     sender and fee payer
 * @param {string} a.to          recipient wallet
 * @param {string} a.mint
 * @param {number} a.decimals
 * @param {bigint} a.amount
 * @param {string} a.memo
 */
export async function splTransferInstructions({ from, to, mint, decimals, amount, memo }) {
	const conn = connection();
	const mintPk = new PublicKey(mint);
	const toPk = new PublicKey(to);
	const programId = await tokenProgramIdForMint(conn, mintPk);
	const fromAta = getAssociatedTokenAddressSync(mintPk, from, true, programId);
	const toAta = getAssociatedTokenAddressSync(mintPk, toPk, true, programId);
	return [
		createAssociatedTokenAccountIdempotentInstruction(from, toAta, toPk, mintPk, programId),
		createTransferCheckedInstruction(fromAta, mintPk, toAta, from, amount, decimals, [], programId),
		new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(memo.slice(0, 180), 'utf8') }),
	];
}

/** Base-unit balance of one SPL mint held by `owner` (0 when it holds none). */
export async function splBalance(owner, mint) {
	const conn = connection();
	const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
	return res.value.reduce((a, acc) => a + BigInt(acc.account.data.parsed?.info?.tokenAmount?.amount ?? '0'), 0n);
}

export async function lamports(owner) {
	return BigInt(await connection().getBalance(new PublicKey(owner), 'confirmed'));
}
