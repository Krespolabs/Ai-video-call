// @ts-check
// Fee Bridge knobs and the bridge signer. Every knob is an env var with a safe
// default; execution stays off until FEE_BRIDGE_ENABLED is truthy AND the signer
// secret is present, so a deploy without them is a clean, recorded no-op.

import { SOLANA_SIGNERS, loadSignerKeypair, resolveSignerPubkey } from '../solana-signers.js';
import { SOLANA_USDC_MINT } from '../../payments/_config.js';
import { TOKEN_MINT } from '../token/config.js';
import { usdToUsdcAtomics } from '../token/buyback-math.js';

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = SOLANA_USDC_MINT;
export const THREE_MINT = TOKEN_MINT;
export const SUPPORTED_QUOTE_MINTS = new Set([NATIVE_SOL_MINT, USDC_MINT]);

function num(name, fallback, { min = -Infinity, max = Infinity } = {}) {
	const n = Number(process.env[name]);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function isEnabled() {
	return /^(1|true|yes|on)$/i.test(String(process.env.FEE_BRIDGE_ENABLED || ''));
}

/** Share of every converted dollar credited to the handle (the rest buys $THREE). */
export function recipientBps() {
	return Math.round(num('FEE_BRIDGE_RECIPIENT_BPS', 8000, { min: 5000, max: 10_000 }));
}

/** Balance at which a linked recipient is paid without asking. */
export function autoPayoutAtomics() {
	return usdToUsdcAtomics(num('FEE_BRIDGE_AUTO_PAYOUT_USD', 5, { min: 1, max: 10_000 }));
}

/** Smallest manual withdrawal. */
export function withdrawMinAtomics() {
	return usdToUsdcAtomics(num('FEE_BRIDGE_WITHDRAW_MIN_USD', 1, { min: 0.1, max: 1000 }));
}

/** A conversion waits until the pending fees are worth at least this much. */
export function minBatchAtomics() {
	return usdToUsdcAtomics(num('FEE_BRIDGE_MIN_BATCH_USD', 5, { min: 0.5, max: 10_000 }));
}

export function slippageBps() {
	return Math.round(num('FEE_BRIDGE_SLIPPAGE_BPS', 100, { min: 10, max: 500 }));
}

/** SOL the bridge keeps back for gas and rent; never swapped. */
export function gasReserveLamports() {
	return BigInt(Math.round(num('FEE_BRIDGE_GAS_RESERVE_SOL', 0.03, { min: 0.005, max: 5 }) * 1e9));
}

/** Minutes between cranks of the same coin. */
export function crankIntervalMinutes() {
	return Math.round(num('FEE_BRIDGE_CRANK_INTERVAL_MIN', 30, { min: 5, max: 1440 }));
}

export function crankPerTick() {
	return Math.round(num('FEE_BRIDGE_CRANK_PER_TICK', 10, { min: 1, max: 50 }));
}

export function payoutsPerTick() {
	return Math.round(num('FEE_BRIDGE_PAYOUTS_PER_TICK', 10, { min: 1, max: 50 }));
}

export const SIGNER_SPEC = /** @type {any} */ (SOLANA_SIGNERS.find((s) => s.name === 'fee-bridge'));

let _pubkey;
/** Bridge wallet address, or null when the signer is not configured. */
export async function bridgeAddress() {
	if (_pubkey !== undefined) return _pubkey;
	const r = await resolveSignerPubkey(SIGNER_SPEC);
	_pubkey = r.pubkey;
	return _pubkey;
}

/** Bridge keypair; throws a typed 503 when unconfigured so callers render cleanly. */
export async function loadBridgeSigner() {
	const r = await loadSignerKeypair(SIGNER_SPEC);
	if (!r.keypair) {
		throw Object.assign(
			new Error(
				r.decodeError
					? `${SIGNER_SPEC.env} is set but does not decode to a Solana keypair`
					: `${SIGNER_SPEC.env} is not configured`,
			),
			{ status: 503, code: 'fee_bridge_unconfigured' },
		);
	}
	return r.keypair;
}

export function publicConfig(address) {
	const bps = recipientBps();
	return {
		enabled: isEnabled() && !!address,
		bridge_wallet: address,
		recipient_bps: bps,
		buyback_bps: 10_000 - bps,
		auto_payout_usd: Number(autoPayoutAtomics()) / 1e6,
		withdraw_min_usd: Number(withdrawMinAtomics()) / 1e6,
		payout_asset: { symbol: 'USDC', chain: 'solana', mint: USDC_MINT },
		buyback_asset: { symbol: '$THREE', chain: 'solana', mint: THREE_MINT },
		supported_quotes: ['SOL', 'USDC'],
	};
}
