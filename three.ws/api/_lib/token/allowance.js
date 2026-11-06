// $THREE spend allowances — frictionless, NON-CUSTODIAL pay-from-wallet.
//
// Built on Solana's native, audited Subscriptions & Allowances program
// (solana-program/subscriptions, program De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44,
// live on mainnet June 2026). It solves the one-delegate-per-token-account limit
// by making a per-(user,mint) Subscription Authority PDA the sole SPL delegate
// (u64::MAX approval) and gating every pull through individual Delegation PDAs.
//
// Why this instead of a custodial credit balance: funds NEVER leave the user's
// wallet until a charge pulls them, the user sets the cap (and revokes anytime),
// and three.ws holds nothing. One signature authorizes a spend cap; after that,
// paid actions debit with no popup — the platform's delegate key pulls up to the
// remaining cap, and the program rejects anything over it.
//
// Two flows:
//   GRANT  (user signs once) — initSubscriptionAuthority (first time) +
//           createFixedDelegation(cap, expiry). buildGrantInstructions().
//   PULL   (delegate signs, no user popup) — one transferFixed per split leg,
//           honoring the exact same treasury/rewards/seller split as the
//           on-chain quote path. pullFromAllowance().
//
// $THREE is a Token-2022 mint with only metadataPointer + tokenMetadata
// extensions (no transfer hook / fee / permanent-delegate), so it is compatible
// with the program, which rejects hook/fee mints. All ATAs and token accounts
// here use the Token-2022 program id accordingly.
//
// Encodings (discriminators, PDA seeds, struct layouts, account offsets) are
// taken verbatim from the program's published IDL (idl/subscriptions.json) and
// covered by tests/token-allowance.test.js so a drift in any constant fails CI.

import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_2022_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { env } from '../env.js';
import { TOKEN_MINT } from './config.js';

// ── Program constants ────────────────────────────────────────────────────────

/** Native Subscriptions & Allowances program (mainnet + devnet, audited by Cantina). */
export const SUBSCRIPTIONS_PROGRAM_ID = new PublicKey(
	'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44',
);

// Instruction discriminators (single leading u8 — see IDL). Only the ones we use.
const IX_INIT_SUBSCRIPTION_AUTHORITY = 0;
const IX_CREATE_FIXED_DELEGATION = 1;
const IX_REVOKE_DELEGATION = 3;
const IX_TRANSFER_FIXED = 4;

// On-chain account byte layouts (from the IDL `accounts` definitions). The
// program writes these little-endian; we read remaining-balance / init-id back.
const SA_INIT_ID_OFFSET = 98; // discriminator(1)+user(32)+mint(32)+payer(32)+bump(1)
const DELEGATION_DATA_SIZE = 187;
const DELEGATION_DELEGATOR_OFFSET = 3; // header: discriminator(1)+version(1)+bump(1)
const DELEGATION_DELEGATEE_OFFSET = 35;
const DELEGATION_AMOUNT_OFFSET = 171; // remaining allowance (decremented per transfer)
const DELEGATION_EXPIRY_OFFSET = 179;

// createFixedDelegation validates the caller-supplied SA init-id against the
// authority's stored init-id within this drift, so a fresh same-tx create can
// pass the current clock. Mirrors the program's TIME_DRIFT_ALLOWED_SECS.
const TIME_DRIFT_ALLOWED_SECS = 120;

const mintPubkey = () => new PublicKey(TOKEN_MINT);

// ── Little-endian scalar encoders ────────────────────────────────────────────

function u64le(value) {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64LE(BigInt(value));
	return buf;
}

function i64le(value) {
	const buf = Buffer.alloc(8);
	buf.writeBigInt64LE(BigInt(value));
	return buf;
}

// ── PDA derivation ───────────────────────────────────────────────────────────

/** Per-(user,mint) Subscription Authority — the single SPL delegate on the user's ATA. */
export function subscriptionAuthorityPda(user, mint = mintPubkey()) {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('SubscriptionAuthority'), new PublicKey(user).toBuffer(), new PublicKey(mint).toBuffer()],
		SUBSCRIPTIONS_PROGRAM_ID,
	)[0];
}

/** A specific spend cap from `delegator` to `delegatee`, keyed by an arbitrary nonce. */
export function fixedDelegationPda({ subscriptionAuthority, delegator, delegatee, nonce }) {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from('delegation'),
			new PublicKey(subscriptionAuthority).toBuffer(),
			new PublicKey(delegator).toBuffer(),
			new PublicKey(delegatee).toBuffer(),
			u64le(nonce),
		],
		SUBSCRIPTIONS_PROGRAM_ID,
	)[0];
}

/** Event-authority PDA the program emits CPI events through (read-only meta on transfers). */
export function eventAuthorityPda() {
	return PublicKey.findProgramAddressSync([Buffer.from('event_authority')], SUBSCRIPTIONS_PROGRAM_ID)[0];
}

/** The user's Token-2022 $THREE associated token account. */
export function userThreeAta(owner, mint = mintPubkey()) {
	return getAssociatedTokenAddressSync(
		new PublicKey(mint),
		new PublicKey(owner),
		true, // allowOwnerOffCurve — receivers (e.g. incinerator) may be off-curve
		TOKEN_2022_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
}

// ── Instruction builders ─────────────────────────────────────────────────────

/** initSubscriptionAuthority (disc 0) — first-time setup; registers the SA as delegate. */
export function ixInitSubscriptionAuthority({ owner, mint = mintPubkey() }) {
	const ownerPk = new PublicKey(owner);
	const sa = subscriptionAuthorityPda(ownerPk, mint);
	return new TransactionInstruction({
		programId: SUBSCRIPTIONS_PROGRAM_ID,
		keys: [
			{ pubkey: ownerPk, isSigner: true, isWritable: true },
			{ pubkey: sa, isSigner: false, isWritable: true },
			{ pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
			{ pubkey: userThreeAta(ownerPk, mint), isSigner: false, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
			{ pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
		],
		data: Buffer.from([IX_INIT_SUBSCRIPTION_AUTHORITY]),
	});
}

/** createFixedDelegation (disc 1) — authorize `delegatee` to pull up to `amount` until `expiryTs`. */
export function ixCreateFixedDelegation({
	delegator,
	delegatee,
	nonce,
	amount,
	expiryTs,
	expectedInitId,
	mint = mintPubkey(),
}) {
	const delegatorPk = new PublicKey(delegator);
	const delegateePk = new PublicKey(delegatee);
	const sa = subscriptionAuthorityPda(delegatorPk, mint);
	const delegation = fixedDelegationPda({
		subscriptionAuthority: sa,
		delegator: delegatorPk,
		delegatee: delegateePk,
		nonce,
	});
	const data = Buffer.concat([
		Buffer.from([IX_CREATE_FIXED_DELEGATION]),
		u64le(nonce),
		u64le(amount),
		i64le(expiryTs),
		i64le(expectedInitId),
	]);
	return new TransactionInstruction({
		programId: SUBSCRIPTIONS_PROGRAM_ID,
		keys: [
			{ pubkey: delegatorPk, isSigner: true, isWritable: true },
			{ pubkey: sa, isSigner: false, isWritable: false },
			{ pubkey: delegation, isSigner: false, isWritable: true },
			{ pubkey: delegateePk, isSigner: false, isWritable: false },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data,
	});
}

/** revokeDelegation (disc 3) — the user (authority) cancels a delegation and reclaims its rent. */
export function ixRevokeDelegation({ authority, delegationPda }) {
	return new TransactionInstruction({
		programId: SUBSCRIPTIONS_PROGRAM_ID,
		keys: [
			{ pubkey: new PublicKey(authority), isSigner: true, isWritable: true },
			{ pubkey: new PublicKey(delegationPda), isSigner: false, isWritable: true },
		],
		data: Buffer.from([IX_REVOKE_DELEGATION]),
	});
}

/** transferFixed (disc 4) — delegate pulls `amount` from the user to `receiver`, decrementing the cap. */
export function ixTransferFixed({ delegationPda, delegator, delegatee, receiver, amount, mint = mintPubkey() }) {
	const mintPk = new PublicKey(mint);
	const delegatorPk = new PublicKey(delegator);
	const delegateePk = new PublicKey(delegatee);
	const sa = subscriptionAuthorityPda(delegatorPk, mintPk);
	const data = Buffer.concat([
		Buffer.from([IX_TRANSFER_FIXED]),
		u64le(amount),
		delegatorPk.toBuffer(),
		mintPk.toBuffer(),
	]);
	return new TransactionInstruction({
		programId: SUBSCRIPTIONS_PROGRAM_ID,
		keys: [
			{ pubkey: new PublicKey(delegationPda), isSigner: false, isWritable: true },
			{ pubkey: sa, isSigner: false, isWritable: false },
			{ pubkey: userThreeAta(delegatorPk, mintPk), isSigner: false, isWritable: true },
			{ pubkey: userThreeAta(receiver, mintPk), isSigner: false, isWritable: true },
			{ pubkey: mintPk, isSigner: false, isWritable: false },
			{ pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
			{ pubkey: delegateePk, isSigner: true, isWritable: false },
			{ pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
			{ pubkey: SUBSCRIPTIONS_PROGRAM_ID, isSigner: false, isWritable: false },
		],
		data,
	});
}

// ── Account-state parsers ────────────────────────────────────────────────────

/** Read the Subscription Authority's stored init-id (i64), or null when uninitialized. */
export function parseSubscriptionAuthorityInitId(data) {
	if (!data || data.length < SA_INIT_ID_OFFSET + 8) return null;
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
	return Number(buf.readBigInt64LE(SA_INIT_ID_OFFSET));
}

/** Decode a fixed-delegation account: remaining allowance, expiry, and parties. */
export function parseFixedDelegation(data) {
	if (!data || data.length < DELEGATION_DATA_SIZE) return null;
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
	return {
		delegator: new PublicKey(buf.subarray(DELEGATION_DELEGATOR_OFFSET, DELEGATION_DELEGATOR_OFFSET + 32)).toBase58(),
		delegatee: new PublicKey(buf.subarray(DELEGATION_DELEGATEE_OFFSET, DELEGATION_DELEGATEE_OFFSET + 32)).toBase58(),
		remaining: buf.readBigUInt64LE(DELEGATION_AMOUNT_OFFSET),
		expiryTs: Number(buf.readBigInt64LE(DELEGATION_EXPIRY_OFFSET)),
	};
}

// ── Delegate (relayer) key ───────────────────────────────────────────────────

let _delegateKeypair;
let _delegateLoadFailed = false;

/**
 * The platform's allowance delegate keypair (the `delegatee` users authorize).
 * Loaded from THREE_ALLOWANCE_DELEGATE_SECRET_KEY_B64 (base64 of a 64-byte secret
 * key). Returns null when unconfigured — every pull path then falls back to the
 * on-chain quote→settle flow, so the feature is safe-by-default: nothing can move
 * funds until an operator funds + configures this key.
 */
export async function loadDelegateKeypair() {
	if (_delegateKeypair || _delegateLoadFailed) return _delegateKeypair ?? null;
	const b64 = env.THREE_ALLOWANCE_DELEGATE_SECRET_KEY_B64;
	if (!b64) {
		_delegateLoadFailed = true;
		return null;
	}
	try {
		const { Keypair } = await import('@solana/web3.js');
		_delegateKeypair = Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
		return _delegateKeypair;
	} catch (err) {
		_delegateLoadFailed = true;
		console.error('[allowance] invalid THREE_ALLOWANCE_DELEGATE_SECRET_KEY_B64:', err?.message || err);
		return null;
	}
}

/** Public base58 address of the delegate, or null when unconfigured. */
export async function delegateAddress() {
	const kp = await loadDelegateKeypair();
	return kp ? kp.publicKey.toBase58() : null;
}

/** True when the allowance rail is operational (a delegate key is configured). */
export async function allowanceEnabled() {
	return (await loadDelegateKeypair()) != null;
}
