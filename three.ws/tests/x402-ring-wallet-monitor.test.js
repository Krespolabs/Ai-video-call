import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// checkRingWallets reads the three ring wallets on-chain and alerts on a role-
// floor breach. These tests inject a fake balance reader + alert sink (the
// function's DI seams) so no RPC, spl-token, or Redis is touched — we assert the
// breach → alert wiring and the treasury's deliberate exemption.

let checkRingWallets;
let SPONSOR;
let PAYER;
let TREASURY;

beforeAll(async () => {
	// Synthetic, matched keypairs. The payer address is derived from the seed
	// secret exactly as production's loadSeedKeypair() does.
	const payerKp = Keypair.generate();
	const treasuryKp = Keypair.generate();
	const sponsorKp = Keypair.generate();
	PAYER = payerKp.publicKey.toBase58();
	TREASURY = treasuryKp.publicKey.toBase58();
	SPONSOR = sponsorKp.publicKey.toBase58();

	process.env.X402_SEED_SOLANA_SECRET_BASE58 = bs58.encode(payerKp.secretKey);
	process.env.X402_PAY_TO_SOLANA = TREASURY;
	process.env.X402_FEE_PAYER_SOLANA = SPONSOR;
	process.env.X402_SPONSOR_SOL_FLOOR_LAMPORTS = '20000000'; // 0.02 SOL → 0.03 watch floor
	process.env.X402_RING_PAYER_USDC_FLOOR_ATOMIC = '5000000'; // $5
	process.env.X402_RING_SELF_PAY = 'true';

	({ checkRingWallets } = await import('../api/_lib/x402/wallet-balance-monitor.js'));
});

afterEach(() => {
	process.env.X402_RING_SELF_PAY = 'true';
});

// Build a fake on-chain reader from a { address: { lamports, usdcAtomic } } map.
function reader(balances) {
	return async (address) => balances[address] || { lamports: null, usdcAtomic: null };
}

function alertCollector() {
	const calls = [];
	return { fn: async (title, detail, opts) => calls.push({ title, detail, opts }), calls };
}

describe('checkRingWallets', () => {
	it('alerts when the sponsor SOL is below floor', async () => {
		const alerts = alertCollector();
		const res = await checkRingWallets({
			sendAlert: alerts.fn,
			readBalance: reader({
				[SPONSOR]: { lamports: 10_000_000, usdcAtomic: null }, // 0.01 SOL < 0.03
				[PAYER]: { lamports: 100_000_000, usdcAtomic: 82_000_000 },
				[TREASURY]: { lamports: 0, usdcAtomic: 0 },
			}),
		});
		expect(res.configured).toBe(true);
		expect(res.breaches.some((b) => b.startsWith('sponsor SOL'))).toBe(true);
		expect(alerts.calls.some((c) => c.title.includes('sponsor low on SOL'))).toBe(true);
	});

	it('alerts when the payer USDC float is below floor', async () => {
		const alerts = alertCollector();
		const res = await checkRingWallets({
			sendAlert: alerts.fn,
			readBalance: reader({
				[SPONSOR]: { lamports: 100_000_000, usdcAtomic: null },
				[PAYER]: { lamports: 100_000_000, usdcAtomic: 3_000_000 }, // $3 < $5
				[TREASURY]: { lamports: 0, usdcAtomic: 0 },
			}),
		});
		expect(res.breaches.some((b) => b.startsWith('payer USDC'))).toBe(true);
		expect(alerts.calls.some((c) => c.title.includes('payer low on USDC'))).toBe(true);
	});

	it('never alerts on the treasury, even at zero balance', async () => {
		const alerts = alertCollector();
		const res = await checkRingWallets({
			sendAlert: alerts.fn,
			readBalance: reader({
				[SPONSOR]: { lamports: 100_000_000, usdcAtomic: null },
				[PAYER]: { lamports: 100_000_000, usdcAtomic: 82_000_000 },
				[TREASURY]: { lamports: 0, usdcAtomic: 0 },
			}),
		});
		expect(res.breaches).toEqual([]);
		expect(alerts.calls).toEqual([]);
		const treasury = res.wallets.find((w) => w.role === 'treasury');
		expect(treasury.sol_low).toBe(false);
		expect(treasury.usdc_low).toBe(false);
	});

	it('does not flag the payer SOL when self-pay is off', async () => {
		process.env.X402_RING_SELF_PAY = 'false';
		const alerts = alertCollector();
		const res = await checkRingWallets({
			sendAlert: alerts.fn,
			readBalance: reader({
				[SPONSOR]: { lamports: 100_000_000, usdcAtomic: null },
				[PAYER]: { lamports: 1_000, usdcAtomic: 82_000_000 }, // near-zero SOL, but sponsor pays
				[TREASURY]: { lamports: 0, usdcAtomic: 0 },
			}),
		});
		expect(res.breaches.some((b) => b.startsWith('payer SOL'))).toBe(false);
	});

	it('does not fabricate a breach from a null (RPC-failed) balance', async () => {
		const alerts = alertCollector();
		const res = await checkRingWallets({
			sendAlert: alerts.fn,
			readBalance: reader({
				[SPONSOR]: { lamports: null, usdcAtomic: null },
				[PAYER]: { lamports: null, usdcAtomic: null },
				[TREASURY]: { lamports: null, usdcAtomic: null },
			}),
		});
		expect(res.breaches).toEqual([]);
		expect(alerts.calls).toEqual([]);
	});
});
