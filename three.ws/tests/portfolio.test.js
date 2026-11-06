/**
 * Portfolio Command — pure-layer tests.
 *
 * buildLots, computeRisk, riskFlags, and buildAttribution are pure (no DB, no
 * network). Every assertion is hand-computed from the fixtures so the FIFO math,
 * the risk metrics, and the attribution can never silently drift.
 */

import { describe, it, expect } from 'vitest';
import { buildLots, computeRisk, riskFlags, buildAttribution } from '../api/_lib/portfolio.js';

const SOL = 1_000_000_000n; // lamports per SOL
const T = (s) => new Date(`2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`).getTime();

describe('buildLots — FIFO cost basis + realized attribution', () => {
	it('matches a full round-trip and attributes realized P&L to the lot source', () => {
		const events = [
			// discretionary buy 1000 raw for 1 SOL
			{ mint: 'M', source: 'discretionary', kind: 'buy', qtyRaw: 1000n, lamports: 1n * SOL, at: T(1) },
			// discretionary sell 1000 raw for 3 SOL → +2 SOL realized
			{ mint: 'M', source: 'discretionary', kind: 'sell', qtyRaw: 1000n, lamports: 3n * SOL, at: T(2) },
		];
		const { realizedBySource, remainingByMint } = buildLots(events);
		expect(realizedBySource.get('discretionary').realizedLamports).toBe(2n * SOL);
		expect(realizedBySource.get('discretionary').sells).toBe(1);
		expect(remainingByMint.has('M')).toBe(false); // fully sold
	});

	it('leaves remaining lots (cost basis) when only partially sold, FIFO order', () => {
		const events = [
			{ mint: 'M', source: 'sniper', kind: 'buy', qtyRaw: 1000n, lamports: 1n * SOL, at: T(1) }, // lot A
			{ mint: 'M', source: 'discretionary', kind: 'buy', qtyRaw: 1000n, lamports: 4n * SOL, at: T(2) }, // lot B
			// sell 1500 → consumes all of A (1000) + 500 of B; proceeds 6 SOL over 1500
			{ mint: 'M', source: 'discretionary', kind: 'sell', qtyRaw: 1500n, lamports: 6n * SOL, at: T(3) },
		];
		const { realizedBySource, remainingByMint } = buildLots(events);
		// A: proceeds for 1000/1500 of 6 SOL = 4 SOL, cost 1 SOL → +3 SOL (source sniper)
		expect(realizedBySource.get('sniper').realizedLamports).toBe(3n * SOL);
		// B slice: proceeds for 500/1500 of 6 SOL = 2 SOL, cost = 4 SOL * 500/1000 = 2 SOL → 0
		expect(realizedBySource.get('discretionary').realizedLamports).toBe(0n);
		// remaining: 500 of B with half its cost (2 SOL)
		const lots = remainingByMint.get('M');
		expect(lots).toHaveLength(1);
		expect(lots[0].qtyRaw).toBe(500n);
		expect(lots[0].costLamports).toBe(2n * SOL);
		expect(lots[0].source).toBe('discretionary');
	});

	it('attributes proceeds with no matching lot (deposited token) to the seller source', () => {
		const events = [
			{ mint: 'M', source: 'discretionary', kind: 'sell', qtyRaw: 1000n, lamports: 2n * SOL, at: T(1) },
		];
		const { realizedBySource, remainingByMint } = buildLots(events);
		expect(realizedBySource.get('discretionary').realizedLamports).toBe(2n * SOL);
		expect(remainingByMint.has('M')).toBe(false);
	});

	it('ignores events with no mint', () => {
		const { realizedBySource } = buildLots([{ mint: null, source: 'x', kind: 'buy', qtyRaw: 1n, lamports: 1n, at: 0 }]);
		expect(realizedBySource.size).toBe(0);
	});
});

describe('computeRisk — concentration, exposure, drawdown', () => {
	const metrics = { max_drawdown_pct: 42, max_drawdown_sol: 1.5 };
	it('computes HHI, top share, and volatile exposure from valued holdings', () => {
		const holdings = [
			{ usd: 8000, mint: 'MEME', isNative: false, stable: false }, // 80%
			{ usd: 1000, mint: null, isNative: true, stable: false }, //   10% SOL
			{ usd: 1000, mint: 'USDC', isNative: false, stable: true }, // 10% stable
		];
		const r = computeRisk(holdings, 10000, metrics, [200, -50, 30, 1]);
		expect(r.net_worth_usd).toBe(10000);
		expect(r.top_position_pct).toBe(80);
		expect(r.top_position_mint).toBe('MEME');
		// HHI = .8^2 + .1^2 + .1^2 = .64 + .01 + .01 = .66
		expect(r.concentration_hhi).toBeCloseTo(0.66, 4);
		// volatile = only MEME (8000) / 10000 = 80%
		expect(r.exposure_pct).toBe(80);
		expect(r.tape_beta).toBe(0.8);
		expect(r.max_drawdown_pct).toBe(42);
		expect(r.valued_count).toBe(3);
	});

	it('treats SOL + stables as reserve, not concentration (fresh wallet)', () => {
		const holdings = [
			{ usd: 0.33, mint: null, isNative: true, stable: false }, // only SOL
		];
		const r = computeRisk(holdings, 0.33, metrics, []);
		expect(r.reserve_pct).toBe(100);
		expect(r.reserve_usd).toBe(0.33);
		expect(r.top_position_is_reserve).toBe(true);
		expect(r.risk_assets_count).toBe(0);
		expect(r.top_risk_position_pct).toBe(0);
		expect(r.top_risk_position_mint).toBe(null);
		expect(r.exposure_pct).toBe(0);
	});

	it('reports the risk sleeve alongside reserve for a mixed wallet', () => {
		const holdings = [
			{ usd: 8000, mint: 'MEME', isNative: false, stable: false }, // 80% volatile
			{ usd: 1000, mint: null, isNative: true, stable: false }, // 10% SOL
			{ usd: 1000, mint: 'USDC', isNative: false, stable: true }, // 10% stable
		];
		const r = computeRisk(holdings, 10000, metrics, []);
		expect(r.reserve_pct).toBe(20); // SOL + USDC
		expect(r.reserve_usd).toBe(2000);
		expect(r.top_position_is_reserve).toBe(false); // MEME is the top holding
		expect(r.top_risk_position_pct).toBe(80);
		expect(r.top_risk_position_mint).toBe('MEME');
		expect(r.risk_assets_count).toBe(1);
	});

	it('counts unpriceable non-native holdings honestly', () => {
		const holdings = [
			{ usd: 100, mint: null, isNative: true, stable: false },
			{ usd: null, mint: 'DEAD', isNative: false, stable: false },
		];
		const r = computeRisk(holdings, 100, metrics, []);
		expect(r.unpriceable_count).toBe(1);
		expect(r.valued_count).toBe(1);
		expect(r.realized_volatility_pct).toBe(0); // <2 samples
	});
});

describe('riskFlags — plain-language flags', () => {
	it('flags concentration, exposure, drawdown, and illiquidity', () => {
		const risk = { top_position_pct: 85, exposure_pct: 92, max_drawdown_pct: 65, unpriceable_count: 2, net_worth_usd: 5000 };
		const flags = riskFlags(risk, false); // top holding not priceable → illiquid
		const texts = flags.map((f) => f.text).join(' | ');
		expect(texts).toMatch(/85% of valued holdings sit in one illiquid position/);
		expect(texts).toMatch(/92% of net worth is in volatile memecoins/);
		expect(texts).toMatch(/drawdown has reached 65%/);
		expect(texts).toMatch(/2 holdings could not be priced/);
		expect(flags.some((f) => f.level === 'danger')).toBe(true);
	});

	it('returns an all-clear info flag when nothing is elevated', () => {
		const risk = { top_position_pct: 20, exposure_pct: 10, max_drawdown_pct: 5, unpriceable_count: 0, net_worth_usd: 1000 };
		const flags = riskFlags(risk, true);
		expect(flags).toHaveLength(1);
		expect(flags[0].level).toBe('info');
		expect(flags[0].text).toMatch(/No elevated/);
	});

	it('never raises concentration risk on a reserve-only wallet — surfaces dry powder', () => {
		// 100% SOL: top_position_pct is 100 but the risk sleeve is empty.
		const risk = {
			top_position_pct: 100, top_risk_position_pct: 0, top_position_is_reserve: true,
			reserve_pct: 100, exposure_pct: 0, max_drawdown_pct: 0, unpriceable_count: 0, net_worth_usd: 0.33,
		};
		const flags = riskFlags(risk, true);
		expect(flags.some((f) => /concentration risk/.test(f.text))).toBe(false);
		expect(flags).toHaveLength(1);
		expect(flags[0].level).toBe('info');
		expect(flags[0].text).toMatch(/dry powder/);
	});

	it('still flags a dominant volatile position even when reserve is present', () => {
		const risk = {
			top_position_pct: 70, top_risk_position_pct: 70, top_position_is_reserve: false,
			reserve_pct: 30, exposure_pct: 70, max_drawdown_pct: 0, unpriceable_count: 0, net_worth_usd: 1000,
		};
		const flags = riskFlags(risk, true);
		expect(flags.some((f) => /70% of valued holdings sit in one position — concentration risk/.test(f.text))).toBe(true);
	});
});

describe('buildAttribution — buckets, realized + unrealized, outflows', () => {
	it('merges realized + unrealized by source and sorts by total', () => {
		const realizedBySource = new Map([
			['sniper:default', { realizedLamports: 2n * SOL, sells: 3 }],
			['discretionary', { realizedLamports: -1n * SOL, sells: 1 }],
		]);
		const unrealizedBySource = new Map([
			['sniper:default', 1n * SOL],
			['discretionary', 1n * SOL],
		]);
		const custodyRows = [
			{ category: 'x402', amount_lamports: Number(SOL / 2n), status: 'confirmed' },
			{ category: 'withdraw', amount_lamports: Number(SOL), status: 'confirmed' },
			{ category: 'trade', amount_lamports: 999, status: 'failed' }, // ignored (failed)
		];
		const attr = buildAttribution({ realizedBySource, unrealizedBySource, custodyRows, solUsd: 200 });

		const sniper = attr.find((a) => a.source === 'sniper');
		expect(sniper.realized_sol).toBe(2);
		expect(sniper.unrealized_sol).toBe(1);
		expect(sniper.total_sol).toBe(3);
		expect(sniper.realized_usd).toBe(400); // 2 SOL * $200
		expect(sniper.sells).toBe(3);

		const disc = attr.find((a) => a.source === 'discretionary');
		expect(disc.total_sol).toBe(0); // -1 realized + 1 unrealized

		const x402 = attr.find((a) => a.source === 'x402');
		expect(x402.is_outflow).toBe(true);
		expect(x402.spent_sol).toBe(0.5);

		const withdraw = attr.find((a) => a.source === 'withdraw');
		expect(withdraw.spent_sol).toBe(1);

		// sorted by total_sol desc → sniper (3) first
		expect(attr[0].source).toBe('sniper');
	});

	it('omits USD when no SOL price is available', () => {
		const attr = buildAttribution({
			realizedBySource: new Map([['discretionary', { realizedLamports: SOL, sells: 1 }]]),
			unrealizedBySource: new Map(),
			custodyRows: [],
			solUsd: null,
		});
		expect(attr[0].realized_sol).toBe(1);
		expect(attr[0].realized_usd).toBe(null);
	});
});
