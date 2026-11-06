import { describe, it, expect } from 'vitest';

import { ringFloorSpecs, evaluateRingWallet, LAMPORTS_PER_SOL } from '../api/_lib/x402/ring-floors.js';

// Role-appropriate floors for the closed-loop ring wallets. These tests pin the
// exact breach semantics the balance monitor relies on: sponsor/payer have SOL
// floors, the payer has a USDC float floor, the treasury has NO floor (it fills
// and gets swept), and a null (RPC-failed) balance never fabricates a breach.

const SOL_FLOOR = 30_000_000; // 0.03 SOL
const USDC_FLOOR = 5_000_000; // $5

describe('ringFloorSpecs', () => {
	it('gives the sponsor a SOL floor and no USDC floor', () => {
		const [sponsor] = ringFloorSpecs({ solFloorLamports: SOL_FLOOR, payerUsdcFloorAtomic: USDC_FLOOR, selfPay: true });
		expect(sponsor.role).toBe('sponsor');
		expect(sponsor.solFloor).toBe(SOL_FLOOR);
		expect(sponsor.usdcFloor).toBeNull();
		expect(sponsor.watchUsdc).toBe(false);
	});

	it('gives the payer a SOL floor only in self-pay mode', () => {
		const selfPay = ringFloorSpecs({ solFloorLamports: SOL_FLOOR, payerUsdcFloorAtomic: USDC_FLOOR, selfPay: true });
		const sponsored = ringFloorSpecs({ solFloorLamports: SOL_FLOOR, payerUsdcFloorAtomic: USDC_FLOOR, selfPay: false });
		expect(selfPay.find((s) => s.role === 'payer').solFloor).toBe(SOL_FLOOR);
		expect(sponsored.find((s) => s.role === 'payer').solFloor).toBeNull();
		// The payer always has its USDC float floor regardless of fee mode.
		expect(selfPay.find((s) => s.role === 'payer').usdcFloor).toBe(USDC_FLOOR);
		expect(sponsored.find((s) => s.role === 'payer').usdcFloor).toBe(USDC_FLOOR);
	});

	it('gives the treasury no floors — it fills and gets swept', () => {
		const treasury = ringFloorSpecs({ solFloorLamports: SOL_FLOOR, payerUsdcFloorAtomic: USDC_FLOOR, selfPay: true })
			.find((s) => s.role === 'treasury');
		expect(treasury.solFloor).toBeNull();
		expect(treasury.usdcFloor).toBeNull();
	});
});

describe('evaluateRingWallet', () => {
	const [sponsor, payer, treasury] = ringFloorSpecs({ solFloorLamports: SOL_FLOOR, payerUsdcFloorAtomic: USDC_FLOOR, selfPay: true });

	it('flags a sponsor below the SOL floor', () => {
		const r = evaluateRingWallet(sponsor, 'Spon', 10_000_000, null); // 0.01 SOL
		expect(r.sol_low).toBe(true);
		expect(r.sol).toBeCloseTo(0.01);
		expect(r.sol_floor).toBeCloseTo(0.03);
	});

	it('does not flag a sponsor at or above the SOL floor', () => {
		expect(evaluateRingWallet(sponsor, 'Spon', SOL_FLOOR, null).sol_low).toBe(false);
		expect(evaluateRingWallet(sponsor, 'Spon', 50_000_000, null).sol_low).toBe(false);
	});

	it('flags a payer below the USDC float floor', () => {
		const r = evaluateRingWallet(payer, 'Pay', 50_000_000, 3_000_000); // 0.05 SOL, $3
		expect(r.usdc_low).toBe(true);
		expect(r.sol_low).toBe(false);
		expect(r.usdc).toBeCloseTo(3);
	});

	it('does not flag a healthy payer', () => {
		const r = evaluateRingWallet(payer, 'Pay', 50_000_000, 82_000_000); // $82
		expect(r.usdc_low).toBe(false);
		expect(r.sol_low).toBe(false);
	});

	it('never flags the treasury, even at zero', () => {
		const r = evaluateRingWallet(treasury, 'Trez', 0, 0);
		expect(r.sol_low).toBe(false);
		expect(r.usdc_low).toBe(false);
		expect(r.sol_floor).toBeNull();
		expect(r.usdc_floor).toBeNull();
	});

	it('treats a null (RPC-failed) balance as unknown, not a breach', () => {
		const r = evaluateRingWallet(sponsor, 'Spon', null, null);
		expect(r.sol_low).toBe(false);
		expect(r.sol).toBeNull();
	});

	it('reports an unconfigured wallet when the address is missing', () => {
		const r = evaluateRingWallet(sponsor, null, 1, 1);
		expect(r.configured).toBe(false);
		expect(r.address).toBeNull();
	});

	it('converts lamports and atomic USDC to human units', () => {
		const r = evaluateRingWallet(payer, 'Pay', 1 * LAMPORTS_PER_SOL, 12_500_000);
		expect(r.sol).toBe(1);
		expect(r.usdc).toBe(12.5);
	});
});
