// On-chain escrow for the Agent Labor Market (Moonshot 01).
//
// A bounty's reward is REAL custody, not a DB flag: when an agent posts a bounty,
// it transfers the reward in $THREE from its own custodial wallet into a dedicated
// platform escrow wallet, which actually holds the funds until the work is verified.
// On a pass the escrow releases the worker's payout and the skill author's royalty;
// on a failure it refunds the poster. Every move is a real SPL transfer over the
// same protected-send path the rest of the platform uses (data-driven priority
// fee + CU, rebroadcast until it lands, hard throw on revert).
//
// The escrow keypair is loaded from LABOR_ESCROW_SECRET_BASE58 (a base58-encoded
// 64-byte secret). Fund-routing fails CLOSED if it is unset in production — a paid
// market must never silently route real $THREE to an unset address — mirroring the
// treasuryWallet() guard in token/config.js.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { transferSolanaUSDC } from './solana-transfer.js';
import { TOKEN_MINT } from './token/config.js';
import {
	isConfigured as treasuryConfigured, getTreasuryKeypair,
	transferSol, lamportBalance, treasuryConnection, SOL,
} from './platform-treasury.js';

let _escrowKp = null;
let _escrowWarned = false;

// The escrow wallet pays its own SOL fees when it RELEASES funds (worker payout,
// royalty, poster refund). Posting only ever credits escrow, so a fresh escrow
// wallet can hold $THREE without SOL — but it cannot release without gas. Keep a
// small SOL buffer topped up from the platform treasury so settlements never get
// stuck waiting on a hand-funded gas balance. A dedicated LABOR_ESCROW_GAS_SECRET
// overrides the shared treasury when an operator wants the gas to come from its
// own wallet. With neither configured this is a clean no-op (releases proceed on
// whatever SOL the escrow already holds; if that is zero the transfer fails loud
// and the bounty stays in a resumable state).
const GAS_OVERRIDE_ENV = 'LABOR_ESCROW_GAS_SECRET';
const GAS_FLOOR_LAMPORTS = BigInt(Math.floor(0.01 * SOL)); // top up when escrow dips below this
const GAS_TOPUP_LAMPORTS = BigInt(Math.floor(0.04 * SOL)); // amount sent per top-up

/** The base58 secret for the escrow wallet, or null (read paths). */
function escrowSecretOrNull() {
	const s = process.env.LABOR_ESCROW_SECRET_BASE58;
	return s && s.trim() ? s.trim() : null;
}

/** Escrow keypair (strict). Throws a typed 503 when unconfigured so callers render
 *  a clean "temporarily unavailable" state instead of an opaque 500. */
export function escrowKeypair() {
	if (_escrowKp) return _escrowKp;
	const secret = escrowSecretOrNull();
	if (!secret) {
		const e = new Error(
			'[labor-escrow] LABOR_ESCROW_SECRET_BASE58 is required to hold/release bounty escrow — refusing to route $THREE through an unconfigured escrow wallet.',
		);
		e.status = 503;
		e.code = 'escrow_unavailable';
		throw e;
	}
	try {
		_escrowKp = Keypair.fromSecretKey(bs58.decode(secret));
	} catch {
		const e = new Error('[labor-escrow] LABOR_ESCROW_SECRET_BASE58 is not a valid base58 64-byte secret key');
		e.status = 503;
		e.code = 'escrow_misconfigured';
		throw e;
	}
	return _escrowKp;
}

/** Non-throwing escrow address for read/status paths (null when unconfigured). */
export function escrowAddressOrNull() {
	const secret = escrowSecretOrNull();
	if (!secret) {
		if (!_escrowWarned) {
			_escrowWarned = true;
			console.warn('[labor-escrow] LABOR_ESCROW_SECRET_BASE58 not set — bounty posting will be unavailable.');
		}
		return null;
	}
	try {
		return escrowKeypair().publicKey.toBase58();
	} catch {
		return null;
	}
}

export function escrowConfigured() {
	return escrowAddressOrNull() != null;
}

function requirePositive(amountAtomics) {
	const amt = BigInt(typeof amountAtomics === 'bigint' ? amountAtomics : String(amountAtomics).split('.')[0]);
	if (amt <= 0n) {
		const e = new Error('escrow amount must be > 0');
		e.status = 400;
		e.code = 'bad_amount';
		throw e;
	}
	return amt;
}

/**
 * Fund escrow: move `amountAtomics` of $THREE from the poster agent's custodial
 * wallet into the escrow wallet. Returns the real funding tx signature.
 * @param {{ fromKeypair: Keypair, amountAtomics: bigint|string }} args
 */
export async function fundEscrow({ fromKeypair, amountAtomics }) {
	if (!fromKeypair?.secretKey) throw new Error('fundEscrow: fromKeypair required');
	const amount = requirePositive(amountAtomics);
	const escrow = escrowKeypair();
	return transferSolanaUSDC({
		fromWallet: bs58.encode(fromKeypair.secretKey),
		toAddress: escrow.publicKey.toBase58(),
		amount,
		mint: TOKEN_MINT,
	});
}

/**
 * Ensure the escrow wallet holds enough SOL to pay release fees, topping it up
 * from the platform treasury when it dips below the floor. Best-effort: never
 * throws (a release can still succeed on the escrow's existing balance), and a
 * no-op when neither a gas wallet nor the shared treasury is configured.
 * @returns {Promise<{ topped: boolean, reason?: string, sig?: string, balance?: string }>}
 */
export async function ensureEscrowGas() {
	const addr = escrowAddressOrNull();
	if (!addr) return { topped: false, reason: 'escrow_unconfigured' };
	if (!treasuryConfigured(GAS_OVERRIDE_ENV)) return { topped: false, reason: 'gas_source_unconfigured' };
	try {
		const conn = treasuryConnection('mainnet');
		const balance = await lamportBalance(conn, addr);
		if (balance >= GAS_FLOOR_LAMPORTS) return { topped: false, reason: 'sufficient', balance: balance.toString() };
		const gasKp = await getTreasuryKeypair(GAS_OVERRIDE_ENV);
		const sig = await transferSol(conn, gasKp, addr, Number(GAS_TOPUP_LAMPORTS));
		return { topped: true, sig, balance: balance.toString() };
	} catch (e) {
		console.error('[labor-escrow] gas top-up failed', e?.message);
		return { topped: false, reason: 'topup_failed' };
	}
}

/**
 * Release from escrow to a destination wallet (worker payout, author royalty, or
 * poster refund). Returns the real settlement tx signature.
 * @param {{ toAddress: string, amountAtomics: bigint|string }} args
 */
export async function payFromEscrow({ toAddress, amountAtomics }) {
	if (!toAddress) throw new Error('payFromEscrow: toAddress required');
	const amount = requirePositive(amountAtomics);
	const escrow = escrowKeypair();
	return transferSolanaUSDC({
		fromWallet: bs58.encode(escrow.secretKey),
		toAddress,
		amount,
		mint: TOKEN_MINT,
	});
}
