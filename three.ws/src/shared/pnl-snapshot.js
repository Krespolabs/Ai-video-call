// pnl-snapshot.js — pure normalizer for the live Portfolio / PnL HUD.
//
// The HUD (on /agent-screen) and the wall badge (on /agents-live) both read an
// agent's live on-chain valuation from one of two real backends that return
// DIFFERENT shapes:
//
//   1. POST /api/agents/balances     — public, batched. Carries the 24h P&L +
//      sparkline derived from real wallet_value_snapshots, the SOL / $THREE
//      breakdown, and the top SPL holdings.
//   2. GET  /api/agents/:id/portfolio[/stream] — owner-only. Carries net worth,
//      per-holding cost basis + unrealized P&L, and risk — but no 24h sparkline.
//
// `toPnlSnapshot()` folds either shape into ONE canonical `PnlSnapshot` the UI
// renders verbatim, so the HUD never branches on which endpoint answered. It is
// pure (no DOM, no fetch, no time) so the $THREE-pinning rule and the percent
// math are unit-tested directly in node (tests/pnl-snapshot.test.js).
//
// $THREE is the only coin this platform features. It is detected against the
// canonical mint, pinned first with a featured marker, and linked to its 3D coin
// page. Every other holding is neutral on-chain data — no promotion, no buy CTA.

export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

/** Live 3D coin page for a mint (verified route: /coin3d?mint=<base58>). */
export const THREE_COIN_URL = `/coin3d?mint=${THREE_MINT}`;

function finite(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function isThreeMint(mint) {
	return typeof mint === 'string' && mint === THREE_MINT;
}

/**
 * @typedef {Object} PnlHolding
 * @property {string|null} mint        SPL mint, or null for native SOL.
 * @property {string}      symbol
 * @property {number|null} valueUsd
 * @property {number|null} valueSol
 * @property {number|null} amount      Token quantity held (UI units).
 * @property {number|null} pct         Share of net worth, 0–100.
 * @property {number|null} unrealizedPct  Owner-only per-holding P&L (else null).
 * @property {string|null} logo
 * @property {boolean}     isThree     True only for the canonical $THREE mint.
 */

/**
 * @typedef {Object} PnlSnapshot
 * @property {boolean}      priced        False when the wallet could not be valued.
 * @property {'balances'|'portfolio'} source
 * @property {string|null}  address
 * @property {boolean}      isOwner
 * @property {number|null}  netWorthSol
 * @property {number|null}  netWorthUsd
 * @property {number|null}  change24hPct  24h % change (balances only; null otherwise).
 * @property {number|null}  change24hUsd
 * @property {number|null}  windowHours   Real span the change covers.
 * @property {number[]}     sparkline     Real USD value series (may be empty).
 * @property {boolean}      hasThree      The agent holds $THREE.
 * @property {PnlHolding[]} holdings      $THREE pinned first, then by USD value desc.
 * @property {number}       holdingsTotal Count before any display truncation.
 */

/** A typed, empty (un-priced) snapshot — the honest "no value yet" state. */
export function emptyPnlSnapshot(extra = {}) {
	return {
		priced: false,
		source: 'balances',
		address: null,
		isOwner: false,
		netWorthSol: null,
		netWorthUsd: null,
		change24hPct: null,
		change24hUsd: null,
		windowHours: null,
		sparkline: [],
		hasThree: false,
		holdings: [],
		holdingsTotal: 0,
		...extra,
	};
}

// Order holdings: $THREE first (featured), then by USD value desc, nulls last.
function rankHoldings(holdings) {
	return holdings.slice().sort((a, b) => {
		if (a.isThree !== b.isThree) return a.isThree ? -1 : 1;
		return (b.valueUsd ?? -1) - (a.valueUsd ?? -1);
	});
}

// Drop the bookkeeping zero-value rows that would only add noise, but always
// keep $THREE (it's featured even at a dust balance) and any genuinely-held row.
function meaningful(h) {
	return h.isThree || (h.amount != null && h.amount > 0) || (h.valueUsd != null && h.valueUsd > 0);
}

// ── balances shape ────────────────────────────────────────────────────────────
// { usd, sol:{amount,usd,price}, usdc:{amount,usd}, three:{amount,usd,price}|null,
//   tokenCount, topHoldings:[{mint,symbol,amount,usd,price,logo}],
//   pnl:{ sparkline:number[], changePct, changeUsd, windowHours } }
function fromBalances(raw) {
	const netWorthUsd = finite(raw.usd);
	const solPrice = finite(raw.sol?.price);
	const toSol = (usd) => (usd != null && solPrice && solPrice > 0 ? usd / solPrice : null);

	const rows = [];
	const seen = new Set();
	const push = (h) => {
		const key = h.mint || 'SOL';
		if (seen.has(key)) return;
		seen.add(key);
		rows.push(h);
	};

	// Native SOL is a real holding the batched summary tracks separately.
	const solUsd = finite(raw.sol?.usd);
	if (raw.sol && (finite(raw.sol.amount) || solUsd)) {
		push({
			mint: null, symbol: 'SOL', amount: finite(raw.sol.amount),
			valueUsd: solUsd, valueSol: finite(raw.sol.amount), unrealizedPct: null,
			logo: null, isThree: false,
		});
	}
	for (const t of Array.isArray(raw.topHoldings) ? raw.topHoldings : []) {
		const usd = finite(t.usd);
		push({
			mint: t.mint || null, symbol: t.symbol || (t.mint ? String(t.mint).slice(0, 4) : '?'),
			amount: finite(t.amount), valueUsd: usd, valueSol: toSol(usd), unrealizedPct: null,
			logo: t.logo || null, isThree: isThreeMint(t.mint),
		});
	}
	// Guarantee $THREE is present + featured even when it didn't rank into top
	// holdings — the scoreboard always shows the platform coin when held.
	const three = raw.three;
	if (three && (finite(three.amount) || finite(three.usd)) && !seen.has(THREE_MINT)) {
		const usd = finite(three.usd);
		push({
			mint: THREE_MINT, symbol: '$THREE', amount: finite(three.amount),
			valueUsd: usd, valueSol: toSol(usd), unrealizedPct: null, logo: null, isThree: true,
		});
	}

	const holdings = rankHoldings(rows.filter(meaningful)).map((h) => ({
		...h,
		pct: h.valueUsd != null && netWorthUsd ? clampPct((h.valueUsd / netWorthUsd) * 100) : null,
	}));

	const pnl = raw.pnl || {};
	return {
		priced: netWorthUsd != null,
		source: 'balances',
		address: raw.address || null,
		isOwner: !!raw.isOwner,
		netWorthSol: toSol(netWorthUsd),
		netWorthUsd,
		change24hPct: finite(pnl.changePct),
		change24hUsd: finite(pnl.changeUsd),
		windowHours: finite(pnl.windowHours),
		sparkline: (Array.isArray(pnl.sparkline) ? pnl.sparkline : []).map(Number).filter(Number.isFinite),
		hasThree: holdings.some((h) => h.isThree),
		holdings,
		holdingsTotal: finite(raw.tokenCount) ?? holdings.length,
	};
}

// ── portfolio shape (owner snapshot / SSE) ──────────────────────────────────────
// { sol_usd, net_worth:{sol,usd,...}, holdings:[{mint,symbol,amount,usd,usd_value,
//   is_three,isNative,unrealized_pct,logo}] }
function fromPortfolio(raw) {
	const solUsd = finite(raw.sol_usd);
	const netWorthUsd = finite(raw.net_worth?.usd);
	const netWorthSol = finite(raw.net_worth?.sol);
	const toSol = (usd) => (usd != null && solUsd && solUsd > 0 ? usd / solUsd : null);

	const rows = (Array.isArray(raw.holdings) ? raw.holdings : []).map((h) => {
		const usd = finite(h.usd_value) ?? finite(h.usd);
		const native = !!h.isNative;
		return {
			mint: native ? null : (h.mint || null),
			symbol: h.symbol || (native ? 'SOL' : h.mint ? String(h.mint).slice(0, 4) : '?'),
			amount: finite(h.amount),
			valueUsd: usd,
			valueSol: native ? finite(h.amount) : toSol(usd),
			unrealizedPct: finite(h.unrealized_pct),
			logo: h.logo || null,
			isThree: h.is_three === true || isThreeMint(h.mint),
		};
	});

	const holdings = rankHoldings(rows.filter(meaningful)).map((h) => ({
		...h,
		pct: h.valueUsd != null && netWorthUsd ? clampPct((h.valueUsd / netWorthUsd) * 100) : null,
	}));

	return {
		priced: netWorthUsd != null,
		source: 'portfolio',
		address: raw.agent?.wallet || raw.address || null,
		isOwner: true, // the portfolio endpoint is owner-gated by construction
		netWorthSol,
		netWorthUsd,
		// The owner snapshot carries lifetime realized/unrealized, not a 24h
		// window, and no sparkline — those stay null here and the HUD keeps the
		// last balances-derived 24h + curve. Never synthesize a fake change.
		change24hPct: null,
		change24hUsd: null,
		windowHours: null,
		sparkline: [],
		hasThree: holdings.some((h) => h.isThree),
		holdings,
		holdingsTotal: holdings.length,
	};
}

function clampPct(p) {
	if (!Number.isFinite(p)) return null;
	return Math.max(0, Math.min(100, Number(p.toFixed(1))));
}

/**
 * Normalize a raw balances entry OR a portfolio snapshot into a `PnlSnapshot`.
 * Returns an empty (un-priced) snapshot for null / unusable input rather than
 * throwing, so a list of mixed-availability wallets maps cleanly.
 *
 * @param {object|null} raw
 * @returns {PnlSnapshot}
 */
export function toPnlSnapshot(raw) {
	if (!raw || typeof raw !== 'object') return emptyPnlSnapshot();
	// Portfolio shape is unambiguous (net_worth object); everything else is the
	// balances summary, including the explicit { usd:null, priced:false } miss.
	if (raw.net_worth && typeof raw.net_worth === 'object') return fromPortfolio(raw);
	if (raw.usd == null && raw.priced === false) {
		return emptyPnlSnapshot({ address: raw.address || null, isOwner: !!raw.isOwner });
	}
	return fromBalances(raw);
}

/**
 * Merge a fresh owner portfolio snapshot onto the standing balances snapshot,
 * keeping the real 24h change + sparkline (which the portfolio stream lacks)
 * while taking the fresher net worth + per-holding cost basis. Pure.
 *
 * @param {PnlSnapshot} base  last balances-derived snapshot (carries 24h+spark)
 * @param {PnlSnapshot} live  fresh portfolio snapshot
 * @returns {PnlSnapshot}
 */
export function mergePortfolioOver(base, live) {
	if (!base || !base.priced) return live;
	if (!live || !live.priced) return base;
	return {
		...live,
		change24hPct: base.change24hPct,
		change24hUsd: base.change24hUsd,
		windowHours: base.windowHours,
		sparkline: base.sparkline,
	};
}

// ── formatters ──────────────────────────────────────────────────────────────

/** Compact USD: cents under $1k, whole dollars to $1M, then $1.2M. */
export function formatUsd(n, { compact = true } = {}) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const abs = Math.abs(v);
	const sign = v < 0 ? '-' : '';
	if (compact && abs >= 1_000_000) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
	if (compact && abs >= 10_000) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
	if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
	if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
	if (abs === 0) return '$0.00';
	return `${sign}$${abs.toFixed(abs < 0.01 ? 4 : 3)}`;
}

/** SOL with trailing-zero trim. */
export function formatSol(n, dp = 3) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const s = Number(n).toFixed(dp).replace(/\.?0+$/, '');
	return `${s || '0'} SOL`;
}

/** Compact token quantity: 412000 → "412K", 1.24e6 → "1.24M". */
export function formatAmount(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const abs = Math.abs(v);
	if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
	if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
	return v.toPrecision(2);
}

/**
 * Pure sparkline geometry from a real USD value series. Honest by construction:
 *   • 0 points → empty (the UI draws a flat "tracking starts now" baseline)
 *   • 1 point  → single (a lone dot at the value, no misleading line)
 *   • N points → a normalized polyline, last-point marker, and min/max for ticks
 * No DOM — returns plain coordinates so both the HUD canvas and tests consume it.
 *
 * @param {number[]} series
 * @param {{ width?:number, height?:number, pad?:number }} [opts]
 * @returns {{ empty:boolean, single:boolean, points:{x:number,y:number}[],
 *             polyline:string, min:number, max:number, last:{x:number,y:number}|null }}
 */
export function buildSparkline(series, { width = 220, height = 48, pad = 3 } = {}) {
	const vals = (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite);
	const base = { empty: vals.length === 0, single: vals.length === 1, points: [], polyline: '', min: 0, max: 0, last: null };
	if (vals.length === 0) return base;

	const min = Math.min(...vals);
	const max = Math.max(...vals);
	const span = max - min || 1;
	const innerW = Math.max(1, width - pad * 2);
	const innerH = Math.max(1, height - pad * 2);

	if (vals.length === 1) {
		const p = { x: width / 2, y: height / 2 };
		return { ...base, min, max, points: [p], last: p };
	}

	const stepX = innerW / (vals.length - 1);
	const points = vals.map((v, i) => ({
		x: Number((pad + i * stepX).toFixed(2)),
		// invert Y: higher value → higher on screen (smaller y)
		y: Number((pad + innerH - ((v - min) / span) * innerH).toFixed(2)),
	}));
	return {
		empty: false,
		single: false,
		points,
		polyline: points.map((p) => `${p.x},${p.y}`).join(' '),
		min,
		max,
		last: points[points.length - 1],
	};
}

/**
 * Format a signed percent into a label + a tone the UI colors by. A tiny dead
 * band around zero reads as "flat" so feed jitter doesn't flicker green/red.
 *
 * @param {number|null} pct
 * @returns {{ text:string, tone:'up'|'down'|'flat'|'none', arrow:string }}
 */
export function formatPnl(pct) {
	if (pct == null || !Number.isFinite(Number(pct))) {
		return { text: '—', tone: 'none', arrow: '' };
	}
	const v = Number(pct);
	const tone = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
	const sign = v > 0 ? '+' : v < 0 ? '−' : '';
	const mag = Math.abs(v);
	const digits = mag >= 100 ? 0 : mag >= 10 ? 1 : 2;
	const arrow = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '→';
	return { text: `${sign}${mag.toFixed(digits)}%`, tone, arrow };
}
