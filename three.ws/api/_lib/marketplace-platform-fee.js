// Platform fee for marketplace skill purchases.
//
// Every paid skill purchase carries a small platform fee that the platform
// collects to keep the marketplace running. The fee is a REAL on-chain transfer
// of the same SPL token (USDC) the buyer is already paying, appended to the
// SAME transaction the buyer signs and routed to the platform treasury wallet.
// There is no second signature and no custody: one transaction pays the creator
// their share AND the platform its fee, atomically.
//
// The fee comes OUT of the listed price — the buyer pays the price, the creator
// receives (price - fee), the treasury receives the fee. The buyer's total is
// never marked up.
//
// Honesty (CLAUDE.md Rule 1 & 9): the fee is never hidden. The purchase-create
// response surfaces a `fee` block and the payment UI shows a "Platform fee" line
// and the creator's net. The fee applies ONLY when BOTH a treasury wallet is
// configured AND the rate is > 0, so an unconfigured environment charges nothing
// — the feature ships inert and never surprise-bills on deploy. Mirrors the
// pump trade-fee module (api/_lib/pump-platform-fee.js).

import { PublicKey } from '@solana/web3.js';
import { resolveSignerPubkey } from './solana-signers.js';

// Hard ceiling — a guard so a fat-fingered env can never charge an absurd fee.
const MAX_FEE_BPS = 1000; // 10%

/**
 * The marketplace platform-fee rate in basis points. Defaults to 0 (OFF) so the
 * fee ships inert and never activates on deploy by surprise — set
 * MARKETPLACE_PLATFORM_FEE_BPS=500 to charge 5% once verified. Clamped to
 * [0, MAX_FEE_BPS]. The fee also requires a configured treasury wallet, so both
 * knobs must be set to bill.
 * @returns {number}
 */
export function marketplaceFeeBps() {
	const raw = process.env.MARKETPLACE_PLATFORM_FEE_BPS;
	const n = raw == null || String(raw).trim() === '' ? 0 : parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(n, MAX_FEE_BPS);
}

let _recipientCache = null; // { at, pubkey }
const RECIPIENT_TTL_MS = 60_000;

/**
 * The fee recipient. An explicit MARKETPLACE_PLATFORM_FEE_WALLET base58 address
 * wins; otherwise we derive the platform treasury keypair's public key (no
 * secret is exposed — only the pubkey). Returns null when neither is configured,
 * which disables the fee (fail-open to no-charge, never break a purchase over
 * fee setup).
 * @returns {Promise<PublicKey|null>}
 */
export async function marketplaceFeeRecipient() {
	if (_recipientCache && Date.now() - _recipientCache.at < RECIPIENT_TTL_MS) {
		return _recipientCache.pubkey;
	}
	let pubkey = null;
	const explicit = (process.env.MARKETPLACE_PLATFORM_FEE_WALLET || '').trim();
	if (explicit) {
		try { pubkey = new PublicKey(explicit); } catch { pubkey = null; }
	}
	if (!pubkey) {
		const r = await resolveSignerPubkey({
			env: 'PLATFORM_TREASURY_KEYPAIR',
			fallbackEnv: 'TREASURY_KEYPAIR',
		});
		if (r.pubkey) {
			try { pubkey = new PublicKey(r.pubkey); } catch { pubkey = null; }
		}
	}
	_recipientCache = { at: Date.now(), pubkey };
	return pubkey;
}

/**
 * Fee in atomic units of the purchase currency: floor(gross * bps / 10_000).
 * @param {bigint|number|string} grossAtomics
 * @param {number} [bps]
 * @returns {bigint}
 */
export function marketplaceFeeAtomics(grossAtomics, bps = marketplaceFeeBps()) {
	let g;
	try {
		g = typeof grossAtomics === 'bigint'
			? grossAtomics
			: BigInt(String(grossAtomics ?? '0').split('.')[0]);
	} catch {
		return 0n;
	}
	if (g <= 0n || bps <= 0) return 0n;
	return (g * BigInt(bps)) / 10_000n;
}

/**
 * Resolve the platform fee for a purchase of `grossAtomics` on Solana. Returns
 * null when no fee applies (rate 0, no treasury configured, or a sub-atomic
 * fee). When a fee applies, the creator's leg is `grossAtomics - feeAtomics`.
 *
 * @param {object} o
 * @param {bigint|number|string} o.grossAtomics  the full listed price (atomic units)
 * @returns {Promise<{ bps: number, feeAtomics: bigint, recipient: PublicKey } | null>}
 */
export async function resolveMarketplaceFee({ grossAtomics }) {
	const bps = marketplaceFeeBps();
	const feeAtomics = marketplaceFeeAtomics(grossAtomics, bps);
	if (feeAtomics <= 0n) return null;

	const recipient = await marketplaceFeeRecipient();
	if (!recipient) return null;

	return { bps, feeAtomics, recipient };
}

export { MAX_FEE_BPS };
