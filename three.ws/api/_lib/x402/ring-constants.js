// Single source of truth for the x402 ring's price/cap constants.
//
// These numbers are consumed in three places that must agree or the config
// validator's `ring_price_exceeds_run_cap` check false-positives (or, worse,
// misses a real contradiction): the ring-settle endpoint's default price, the
// volume loop's per-run cap, and the pure `ring-config.js` validator. Before
// this module each kept its own hand-copied literal. Import from here instead —
// this file is dependency-free (no db/pay/web3), so even the pure config module
// can import it without dragging the pipeline's load-time deps in.

/**
 * ring-settle default price in USDC atomic units ($1.00). The default must be
 * affordable from the ring payer's REAL balance or every settle tick skips on
 * `insufficient_payer_usdc` back-pressure and the whole visible ring economy
 * flat-lines (this happened in production when the default was lifted to $35
 * ahead of funding that never arrived). Scaling volume up is an env change, not
 * a code change: fund the payer, then raise `X402_PRICE_RING_SETTLE` (and the
 * caps below) together.
 */
export const RING_SETTLE_DEFAULT_PRICE_ATOMICS = '1000000';

/**
 * Volume-loop per-run cap default in USDC atomic units ($1.10). Must stay
 * ≥ RING_SETTLE_DEFAULT_PRICE_ATOMICS or the config validator raises
 * `ring_price_exceeds_run_cap` and the ring skips ring-settle every tick. Env
 * `X402_VOLUME_PER_RUN_CAP_ATOMIC` overrides it.
 */
export const VOLUME_PER_RUN_CAP_ATOMIC_DEFAULT = 1_100_000;

/** Resolve the per-run cap, honoring the env override. */
export function volumePerRunCapAtomic() {
	return Math.max(0, Number(process.env.X402_VOLUME_PER_RUN_CAP_ATOMIC || VOLUME_PER_RUN_CAP_ATOMIC_DEFAULT));
}
