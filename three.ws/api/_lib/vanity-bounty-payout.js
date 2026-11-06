/**
 * Real on-chain USDC payout + refund rails for the grind-bounty market.
 *
 * Escrow model: a requester funds a bounty by paying the platform via x402 (USDC
 * on Base or Solana) up front. That USDC lands in the platform's receiving
 * wallet and is held as escrow against the bounty record. When a worker submits a
 * verified, sealed, pattern-matching claim, the platform pays the worker the
 * bounty from its Solana USDC payout wallet (`VANITY_BOUNTY_PAYOUT_KEY`). If the
 * bounty expires unfilled, the same wallet refunds the requester. Both legs are
 * real on-chain SPL transfers (reusing the audited transferSolanaUSDC helper) —
 * no fake balances.
 *
 * Money-safety invariants enforced here + in the store:
 *   • A worker is paid ONLY after claimBounty() atomically marks the bounty
 *     settled for that exact claim — so payout can never fire for a losing or
 *     unverified claim, and never for two workers.
 *   • Payout is idempotent: the on-chain send is keyed to the bounty id, and the
 *     store records the resulting tx; a settled bounty that already has a payoutTx
 *     short-circuits instead of paying again.
 *   • A bounty can be EITHER settled (worker paid) OR refunded (requester repaid),
 *     never both — the two transitions are mutually-exclusive compare-and-sets.
 *   • Refund only fires after the expiry compare-and-set; a still-live or settled
 *     bounty is ineligible.
 *
 * Payouts are Solana-only (the platform's payout wallet holds Solana USDC), which
 * is independent of how the requester funded the escrow (Base or Solana x402) —
 * the worker/requester supplies the Solana address they want paid to.
 */

import bs58 from 'bs58';

import { transferSolanaUSDC } from './solana-transfer.js';
import { SOLANA_USDC_MINT } from '../payments/_config.js';
import { env } from './env.js';
import { getBountyRecord, recordPayout, recordRefund } from './vanity-bounty-store.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Resolve the payout wallet as a Base58 64-byte secret from either the dedicated
// VANITY_BOUNTY_PAYOUT_KEY (Base58) or the existing base64 club treasury secret.
function resolvePayoutKeyBase58() {
	const dedicated = env.VANITY_BOUNTY_PAYOUT_KEY;
	if (dedicated && dedicated.trim()) {
		const s = dedicated.trim();
		// Validate it decodes to 64 bytes so a misconfig fails loud, not on-chain.
		try {
			if (bs58.decode(s).length === 64) return s;
		} catch {
			/* not Base58 — fall through to base64 attempt below */
		}
		try {
			const raw = Buffer.from(s, 'base64');
			if (raw.byteLength === 64) return bs58.encode(raw);
		} catch {
			/* ignore */
		}
	}
	const clubB64 = process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
	if (clubB64) {
		try {
			const raw = Buffer.from(clubB64, 'base64');
			if (raw.byteLength === 64) return bs58.encode(raw);
		} catch {
			/* ignore */
		}
	}
	return null;
}

/** Resolve the payout wallet secret (Base58 64-byte) or throw a clear 503. */
function payoutWallet() {
	const key = resolvePayoutKeyBase58();
	if (!key) {
		throw Object.assign(
			new Error('bounty payout wallet is not configured — set VANITY_BOUNTY_PAYOUT_KEY (Base58 64-byte secret)'),
			{ status: 503, code: 'payout_unconfigured' },
		);
	}
	return key;
}

/** True when the platform can actually pay out (wallet configured + valid). */
export function payoutConfigured() {
	return !!resolvePayoutKeyBase58();
}

/**
 * Pay the winning worker the bounty amount in USDC on Solana. Idempotent: if the
 * bounty already carries a payoutTx, returns it without re-sending. Requires the
 * bounty to already be `settled` (the atomic claim ran first).
 *
 * @param {object} p
 * @param {string} p.id - bounty id (must be settled).
 * @param {string} p.toAddress - the worker's Solana payout address.
 * @returns {Promise<{ payoutTx:string, amountAtomics:number, alreadyPaid:boolean }>}
 */
export async function payWinner({ id, toAddress }) {
	const rec = await getBountyRecord(id);
	if (!rec) throw Object.assign(new Error('bounty not found'), { status: 404, code: 'not_found' });
	if (rec.status !== 'settled') {
		throw Object.assign(new Error(`bounty ${id} is ${rec.status}, not settled — cannot pay out`), {
			status: 409,
			code: 'not_settled',
		});
	}
	if (rec.payoutTx) {
		return { payoutTx: rec.payoutTx, amountAtomics: rec.amountAtomics, alreadyPaid: true };
	}
	if (!BASE58_RE.test(String(toAddress || ''))) {
		throw Object.assign(new Error('worker payout address must be a Base58 Solana address'), {
			status: 400,
			code: 'invalid_payout_address',
		});
	}
	const fromWallet = payoutWallet();
	const sig = await transferSolanaUSDC({
		fromWallet,
		toAddress,
		amount: BigInt(rec.amountAtomics),
		mint: SOLANA_USDC_MINT,
	});
	await recordPayout({ id, payoutTx: sig, workerId: rec.winnerWorkerId, amountAtomics: rec.amountAtomics });
	return { payoutTx: sig, amountAtomics: rec.amountAtomics, alreadyPaid: false };
}

/**
 * Refund an expired, unfilled bounty's escrow to the requester. Requires the
 * bounty to already be marked `refunded` by the atomic expiry compare-and-set.
 * Idempotent on refundTx.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.toAddress - the requester's Solana refund address.
 * @returns {Promise<{ refundTx:string, amountAtomics:number, alreadyRefunded:boolean }>}
 */
export async function refundRequester({ id, toAddress }) {
	const rec = await getBountyRecord(id);
	if (!rec) throw Object.assign(new Error('bounty not found'), { status: 404, code: 'not_found' });
	if (rec.status !== 'refunded') {
		throw Object.assign(new Error(`bounty ${id} is ${rec.status}, not refundable`), {
			status: 409,
			code: 'not_refundable',
		});
	}
	if (rec.refundTx) {
		return { refundTx: rec.refundTx, amountAtomics: rec.amountAtomics, alreadyRefunded: true };
	}
	const refundTo = toAddress || rec.refundAddress;
	if (!BASE58_RE.test(String(refundTo || ''))) {
		throw Object.assign(new Error('requester refund address must be a Base58 Solana address'), {
			status: 400,
			code: 'invalid_refund_address',
		});
	}
	const fromWallet = payoutWallet();
	const sig = await transferSolanaUSDC({
		fromWallet,
		toAddress: refundTo,
		amount: BigInt(rec.amountAtomics),
		mint: SOLANA_USDC_MINT,
	});
	await recordRefund({ id, refundTx: sig });
	return { refundTx: sig, amountAtomics: rec.amountAtomics, alreadyRefunded: false };
}
