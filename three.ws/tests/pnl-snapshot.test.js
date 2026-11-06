import { describe, it, expect } from 'vitest';
import {
	toPnlSnapshot,
	emptyPnlSnapshot,
	mergePortfolioOver,
	buildSparkline,
	formatPnl,
	formatUsd,
	formatSol,
	formatAmount,
	THREE_MINT,
	THREE_COIN_URL,
} from '../src/shared/pnl-snapshot.js';

// ── fixtures ──────────────────────────────────────────────────────────────────
// A balances entry: net worth $1000, SOL $400 @ $200/SOL, $THREE $250 (NOT in
// topHoldings, to prove it still gets pinned), plus two other SPL holdings.
const BALANCES = {
	agentId: 'a1',
	address: 'Wa11etAddr1111111111111111111111111111111',
	isOwner: false,
	usd: 1000,
	sol: { amount: 2, usd: 400, price: 200 },
	usdc: { amount: 100, usd: 100 },
	three: { amount: 5_000_000, usd: 250, price: 0.00005 },
	tokenCount: 4,
	topHoldings: [
		{ mint: 'MintAAA', symbol: 'AAA', amount: 1000, usd: 200, price: 0.2, logo: 'http://x/a.png' },
		{ mint: 'MintBBB', symbol: 'BBB', amount: 500, usd: 150, price: 0.3, logo: null },
	],
	pnl: { sparkline: [900, 950, 1000], changePct: 11.11, changeUsd: 100, windowHours: 24 },
};

// A balances entry where $THREE DID rank into topHoldings — must not duplicate.
const BALANCES_THREE_RANKED = {
	agentId: 'a2',
	address: 'Wa11etAddr2222222222222222222222222222222',
	isOwner: true,
	usd: 500,
	sol: { amount: 1, usd: 200, price: 200 },
	usdc: { amount: 0, usd: 0 },
	three: { amount: 9_000_000, usd: 300, price: 0.0000333 },
	tokenCount: 2,
	topHoldings: [
		{ mint: THREE_MINT, symbol: '$THREE', amount: 9_000_000, usd: 300, price: 0.0000333, logo: null },
	],
	pnl: { sparkline: [], changePct: null, changeUsd: null, windowHours: null },
};

// An owner portfolio snapshot (different shape: net_worth + holdings + is_three).
const PORTFOLIO = {
	agent: { wallet: 'Wa11etAddr1111111111111111111111111111111' },
	sol_usd: 200,
	net_worth: { sol: 5, usd: 1000, realized_pnl_usd: 12 },
	holdings: [
		{ isNative: true, symbol: 'SOL', amount: 2, usd: 400, usd_value: 400 },
		{ mint: THREE_MINT, symbol: '$THREE', amount: 5_000_000, usd_value: 250, is_three: true, unrealized_pct: 18.5 },
		{ mint: 'MintAAA', symbol: 'AAA', amount: 1000, usd_value: 350, unrealized_pct: -4.2 },
	],
};

describe('toPnlSnapshot — balances shape', () => {
	const snap = toPnlSnapshot(BALANCES);

	it('marks it priced from the balances source', () => {
		expect(snap.priced).toBe(true);
		expect(snap.source).toBe('balances');
		expect(snap.address).toBe(BALANCES.address);
	});

	it('reports net worth in USD and derives SOL via the SOL price', () => {
		expect(snap.netWorthUsd).toBe(1000);
		expect(snap.netWorthSol).toBeCloseTo(5, 6); // 1000 / 200
	});

	it('carries the real 24h change + sparkline', () => {
		expect(snap.change24hPct).toBeCloseTo(11.11, 2);
		expect(snap.change24hUsd).toBe(100);
		expect(snap.windowHours).toBe(24);
		expect(snap.sparkline).toEqual([900, 950, 1000]);
	});

	it('pins $THREE first even when it is absent from topHoldings', () => {
		expect(snap.hasThree).toBe(true);
		expect(snap.holdings[0].isThree).toBe(true);
		expect(snap.holdings[0].mint).toBe(THREE_MINT);
		// Only one $THREE row.
		expect(snap.holdings.filter((h) => h.isThree)).toHaveLength(1);
	});

	it('ranks the remaining holdings by USD value, $THREE excluded from that order', () => {
		const after = snap.holdings.filter((h) => !h.isThree).map((h) => h.symbol);
		// SOL ($400) > AAA ($200) > BBB ($150)
		expect(after).toEqual(['SOL', 'AAA', 'BBB']);
	});

	it('computes each holding share of net worth', () => {
		const three = snap.holdings.find((h) => h.isThree);
		expect(three.pct).toBeCloseTo(25, 1); // 250 / 1000
		const sol = snap.holdings.find((h) => h.symbol === 'SOL');
		expect(sol.pct).toBeCloseTo(40, 1);
	});
});

describe('toPnlSnapshot — $THREE already ranked', () => {
	it('does not duplicate $THREE when it is in topHoldings', () => {
		const snap = toPnlSnapshot(BALANCES_THREE_RANKED);
		expect(snap.holdings.filter((h) => h.isThree)).toHaveLength(1);
		expect(snap.holdings[0].isThree).toBe(true);
		expect(snap.isOwner).toBe(true);
	});
});

describe('toPnlSnapshot — portfolio shape', () => {
	const snap = toPnlSnapshot(PORTFOLIO);

	it('detects the portfolio source and is owner by construction', () => {
		expect(snap.source).toBe('portfolio');
		expect(snap.isOwner).toBe(true);
		expect(snap.priced).toBe(true);
	});

	it('takes net worth straight from net_worth', () => {
		expect(snap.netWorthUsd).toBe(1000);
		expect(snap.netWorthSol).toBe(5);
	});

	it('has no 24h change or sparkline (the stream does not carry them)', () => {
		expect(snap.change24hPct).toBeNull();
		expect(snap.sparkline).toEqual([]);
	});

	it('pins $THREE and surfaces per-holding unrealized P&L', () => {
		expect(snap.holdings[0].isThree).toBe(true);
		expect(snap.holdings[0].unrealizedPct).toBe(18.5);
		const aaa = snap.holdings.find((h) => h.symbol === 'AAA');
		expect(aaa.unrealizedPct).toBe(-4.2);
	});
});

describe('toPnlSnapshot — misses & junk', () => {
	it('maps the explicit unpriced miss to an empty snapshot keeping the address', () => {
		const snap = toPnlSnapshot({ agentId: 'x', address: 'AddrX', isOwner: true, usd: null, priced: false });
		expect(snap.priced).toBe(false);
		expect(snap.address).toBe('AddrX');
		expect(snap.isOwner).toBe(true);
		expect(snap.holdings).toEqual([]);
	});

	it('returns an empty snapshot for null / non-object input rather than throwing', () => {
		expect(toPnlSnapshot(null).priced).toBe(false);
		expect(toPnlSnapshot(undefined).priced).toBe(false);
		expect(toPnlSnapshot(42).priced).toBe(false);
	});

	it('emptyPnlSnapshot is a stable un-priced shape', () => {
		const e = emptyPnlSnapshot();
		expect(e.priced).toBe(false);
		expect(e.sparkline).toEqual([]);
		expect(e.holdings).toEqual([]);
		expect(e.hasThree).toBe(false);
	});
});

describe('mergePortfolioOver', () => {
	it('keeps the balances 24h + sparkline but takes the fresher portfolio body', () => {
		const base = toPnlSnapshot(BALANCES);            // has 24h + sparkline
		const live = toPnlSnapshot({ ...PORTFOLIO, net_worth: { sol: 6, usd: 1200 } });
		const merged = mergePortfolioOver(base, live);
		expect(merged.netWorthUsd).toBe(1200);           // fresher
		expect(merged.change24hPct).toBeCloseTo(11.11, 2); // preserved from balances
		expect(merged.sparkline).toEqual([900, 950, 1000]);
		expect(merged.source).toBe('portfolio');
	});

	it('falls back to whichever side is priced', () => {
		const base = toPnlSnapshot(BALANCES);
		expect(mergePortfolioOver(base, emptyPnlSnapshot())).toBe(base);
		expect(mergePortfolioOver(emptyPnlSnapshot(), base)).toBe(base);
	});
});

describe('buildSparkline — edge cases', () => {
	it('0 points → empty (UI draws the "tracking starts now" baseline)', () => {
		const g = buildSparkline([]);
		expect(g.empty).toBe(true);
		expect(g.single).toBe(false);
		expect(g.points).toEqual([]);
		expect(g.last).toBeNull();
	});

	it('1 point → a single centered dot, no misleading line', () => {
		const g = buildSparkline([42], { width: 200, height: 48 });
		expect(g.empty).toBe(false);
		expect(g.single).toBe(true);
		expect(g.points).toHaveLength(1);
		expect(g.last).toEqual({ x: 100, y: 24 });
	});

	it('N points → a normalized polyline within the padded box', () => {
		const g = buildSparkline([0, 5, 10], { width: 220, height: 48, pad: 4 });
		expect(g.empty).toBe(false);
		expect(g.single).toBe(false);
		expect(g.points).toHaveLength(3);
		expect(g.min).toBe(0);
		expect(g.max).toBe(10);
		// first x at pad, last x at width-pad; highest value sits at the top (min y).
		expect(g.points[0].x).toBeCloseTo(4, 5);
		expect(g.points[2].x).toBeCloseTo(216, 5);
		expect(g.points[2].y).toBeCloseTo(4, 5);   // value 10 (max) → top
		expect(g.points[0].y).toBeCloseTo(44, 5);  // value 0 (min) → bottom
		expect(g.polyline.split(' ')).toHaveLength(3);
	});

	it('flat series (all equal) does not divide by zero', () => {
		const g = buildSparkline([7, 7, 7]);
		expect(g.points.every((p) => Number.isFinite(p.y))).toBe(true);
	});

	it('drops NaN / Infinity from the series', () => {
		const g = buildSparkline([1, NaN, 3, Infinity]);
		expect(g.points).toHaveLength(2);
	});
});

describe('formatPnl', () => {
	it('signs and tones a positive change', () => {
		const r = formatPnl(12.4);
		expect(r.tone).toBe('up');
		expect(r.text).toBe('+12.4%');
		expect(r.arrow).toBe('▲');
	});

	it('signs and tones a negative change with a minus glyph', () => {
		const r = formatPnl(-3.05);
		expect(r.tone).toBe('down');
		expect(r.text).toBe('−3.05%');
		expect(r.arrow).toBe('▼');
	});

	it('treats a tiny change as flat (dead band)', () => {
		expect(formatPnl(0.01).tone).toBe('flat');
		expect(formatPnl(0).tone).toBe('flat');
	});

	it('returns a none tone for null / non-finite', () => {
		expect(formatPnl(null).tone).toBe('none');
		expect(formatPnl(NaN).tone).toBe('none');
	});

	it('drops decimals for large magnitudes', () => {
		expect(formatPnl(150).text).toBe('+150%');
	});
});

describe('formatUsd / formatSol / formatAmount', () => {
	it('formats compact USD', () => {
		expect(formatUsd(1_500_000)).toBe('$1.50M');
		expect(formatUsd(12_345)).toBe('$12.3k');
		expect(formatUsd(1234)).toBe('$1,234');
		expect(formatUsd(12.5)).toBe('$12.50');
		expect(formatUsd(0)).toBe('$0.00');
		expect(formatUsd(null)).toBe('—');
	});

	it('formats a tiny but real holding truthfully (no rounding to zero)', () => {
		expect(formatUsd(0.0001)).toBe('$0.0001');
	});

	it('formats SOL with trailing-zero trim', () => {
		expect(formatSol(5)).toBe('5 SOL');
		expect(formatSol(1.2300)).toBe('1.23 SOL');
		expect(formatSol(null)).toBe('—');
	});

	it('formats compact token amounts', () => {
		expect(formatAmount(412_000)).toBe('412K');
		expect(formatAmount(1_240_000)).toBe('1.24M');
	});
});

describe('$THREE constants', () => {
	it('exposes the canonical mint and a live 3D coin link', () => {
		expect(THREE_MINT).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(THREE_COIN_URL).toBe(`/coin3d?mint=${THREE_MINT}`);
	});
});
