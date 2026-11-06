// api/_lib/x402/ring-floors.js
//
// Pure floor-evaluation for the three closed-loop ring wallets (payer,
// treasury, sponsor). No network, no @solana imports — balances are passed in,
// verdicts come out. Kept dependency-free on purpose: the balance monitor reads
// the chain and hands the numbers here, and this stays cheap to unit-test and
// impossible to break with an RPC hiccup.
//
// Floors are role-appropriate:
//   • sponsor SOL — the fee wallet. Below the facilitator's hard floor
//     settlement is refused and the ring halts; we watch a little above it.
//   • payer SOL — only in self-pay mode, where the payer signs (and pays) its
//     own 1-signature fee, so it needs the same SOL headroom as the sponsor.
//   • payer USDC — the recirculating float; below it the daily cap can't fund.
//   • treasury — NO floor. It only receives payments and is swept back to the
//     payer, so a low balance is its healthy resting state, not an alert.

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Build the per-role floor spec.
 * @param {object} cfg
 * @param {number} cfg.solFloorLamports        SOL floor for sponsor (and payer in self-pay)
 * @param {number} cfg.payerUsdcFloorAtomic    USDC float floor for the payer (atomic, 6dp)
 * @param {boolean} cfg.selfPay                 X402_RING_SELF_PAY — payer pays its own fee
 * @returns {{ role: string, solFloor: number|null, usdcFloor: number|null, watchUsdc: boolean }[]}
 */
export function ringFloorSpecs({ solFloorLamports, payerUsdcFloorAtomic, selfPay }) {
	return [
		{ role: 'sponsor', solFloor: solFloorLamports, usdcFloor: null, watchUsdc: false },
		{ role: 'payer', solFloor: selfPay ? solFloorLamports : null, usdcFloor: payerUsdcFloorAtomic, watchUsdc: true },
		// Treasury USDC is read for the dashboard but has no floor — informational.
		{ role: 'treasury', solFloor: null, usdcFloor: null, watchUsdc: true },
	];
}

/**
 * Evaluate one wallet's live balances against its floor spec.
 * A null balance (RPC failure) never counts as a breach — we don't fabricate an
 * alert from a missing reading.
 *
 * @param {{ role: string, solFloor: number|null, usdcFloor: number|null }} spec
 * @param {string|null} address
 * @param {number|null} lamports    live SOL balance in lamports (null = unknown)
 * @param {number|null} usdcAtomic  live USDC balance atomic (null = unknown)
 */
export function evaluateRingWallet(spec, address, lamports, usdcAtomic) {
	if (!address) return { role: spec.role, address: null, configured: false };
	const solLow = spec.solFloor != null && lamports != null && lamports < spec.solFloor;
	const usdcLow = spec.usdcFloor != null && usdcAtomic != null && usdcAtomic < spec.usdcFloor;
	return {
		role: spec.role,
		address,
		configured: true,
		sol: lamports != null ? lamports / LAMPORTS_PER_SOL : null,
		usdc: usdcAtomic != null ? usdcAtomic / 1e6 : null,
		sol_floor: spec.solFloor != null ? spec.solFloor / LAMPORTS_PER_SOL : null,
		usdc_floor: spec.usdcFloor != null ? spec.usdcFloor / 1e6 : null,
		sol_low: solLow,
		usdc_low: usdcLow,
	};
}
