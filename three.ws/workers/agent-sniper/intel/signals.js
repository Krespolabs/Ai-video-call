// Coin Intelligence — signal computation. Pure, no I/O, fully deterministic.
//
// Given an `observation` of a pump.fun coin's first seconds of trading, derive
// the signals that separate organic launches from bundles, sniper swarms, and
// dev dumps. Every number traces to a real observed trade — nothing is invented.
// Signals that need data we may not have (wallet age, funding source) return
// `null` rather than a fabricated value (Rule 1).
//
// Observation shape (built by watcher.js):
//   {
//     mint, symbol, name, creator,
//     createdAtMs,            // coin creation (best-effort, from feed)
//     firstSeenAtMs,          // when we started observing
//     endedAtMs,              // when the window closed
//     devBuyLamports,         // creator's initial buy (lamports) | null
//     trades: [ {             // every buy/sell observed, in arrival order
//       trader, isBuy, lamports, baseAmount, ts (ms), signature
//     } ],
//     walletMeta?: Map<wallet, { ageMs?, funder?, priorTxCount? }>  // optional RPC enrichment
//   }
//
// Returns a structured signals object plus a 0..100 quality score and risk flags.

const LAMPORTS_PER_SOL = 1_000_000_000;

// Window (ms from first trade) we treat as the "launch burst" — bundles and
// snipers pile in here. We measure from the first observed trade, not from
// createdAtMs, because feed delivery jitter makes absolute creation time noisy;
// relative arrival ordering is reliable.
const BURST_MS = 3_000;
const SNIPE_MS = 5_000;

function lamportsToSol(l) {
	const n = Number(l);
	return Number.isFinite(n) ? n / LAMPORTS_PER_SOL : 0;
}

function sum(arr) {
	let s = 0;
	for (const x of arr) s += x;
	return s;
}

function median(nums) {
	if (!nums.length) return 0;
	const s = [...nums].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp01(x) {
	if (!Number.isFinite(x)) return 0;
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round(x, places = 4) {
	if (!Number.isFinite(x)) return null;
	const f = 10 ** places;
	return Math.round(x * f) / f;
}

// Shannon entropy of a distribution, normalized to 0..1 against log(n). High
// entropy = evenly spread (organic); low = concentrated/clustered (coordinated).
function normalizedEntropy(counts) {
	const total = sum(counts);
	if (total <= 0 || counts.length <= 1) return 0;
	let h = 0;
	for (const c of counts) {
		if (c <= 0) continue;
		const p = c / total;
		h -= p * Math.log(p);
	}
	return clamp01(h / Math.log(counts.length));
}

/**
 * Aggregate per-wallet activity from the trade list.
 * @returns Map<wallet, { buyCount, sellCount, buyLamports, sellLamports, baseBought, baseSold, firstTs, lastTs }>
 */
export function aggregateWallets(trades) {
	const m = new Map();
	for (const t of trades) {
		if (!t.trader) continue;
		let w = m.get(t.trader);
		if (!w) {
			w = { buyCount: 0, sellCount: 0, buyLamports: 0, sellLamports: 0, baseBought: 0, baseSold: 0, firstTs: t.ts, lastTs: t.ts };
			m.set(t.trader, w);
		}
		const lp = Number(t.lamports) || 0;
		const base = Number(t.baseAmount) || 0;
		if (t.isBuy) { w.buyCount++; w.buyLamports += lp; w.baseBought += base; }
		else { w.sellCount++; w.sellLamports += lp; w.baseSold += base; }
		if (t.ts < w.firstTs) w.firstTs = t.ts;
		if (t.ts > w.lastTs) w.lastTs = t.ts;
	}
	return m;
}

/**
 * Detect the launch-burst bundle signature: many distinct wallets buying within
 * the first BURST_MS with tightly-clustered sizes. Returns 0..1.
 *
 * Three independent tells, blended:
 *   - burst density: share of all buys that hit in the opening burst
 *   - size clustering: largest near-identical-amount cluster among burst buys
 *   - wallet multiplicity: many distinct wallets in the burst (a real degen
 *     rush has them too, so this only amplifies the other two, never alone)
 */
export function bundleScore(trades) {
	const buys = trades.filter((t) => t.isBuy);
	if (buys.length < 4) return 0;
	const t0 = Math.min(...buys.map((b) => b.ts));
	const burst = buys.filter((b) => b.ts - t0 <= BURST_MS);
	if (burst.length < 4) return 0;

	const burstDensity = burst.length / buys.length;

	// Size clustering: bucket burst buy sizes to 2 sig-figs of SOL and find the
	// largest bucket. Bots fund identical amounts; humans don't.
	const buckets = new Map();
	for (const b of burst) {
		const sol = lamportsToSol(b.lamports);
		if (sol <= 0) continue;
		// round to 2 significant figures
		const mag = sol === 0 ? 0 : Math.floor(Math.log10(Math.abs(sol)));
		const f = 10 ** (mag - 1);
		const key = f > 0 ? Math.round(sol / f) * f : sol;
		buckets.set(key, (buckets.get(key) || 0) + 1);
	}
	const largestBucket = buckets.size ? Math.max(...buckets.values()) : 0;
	const clustering = burst.length ? largestBucket / burst.length : 0;

	const distinctBurstWallets = new Set(burst.map((b) => b.trader)).size;
	const walletMultiplier = distinctBurstWallets >= 5 ? 1 : distinctBurstWallets / 5;

	// Blend: density and clustering are the real signal; wallet count amplifies.
	const raw = (burstDensity * 0.5 + clustering * 0.5) * (0.6 + 0.4 * walletMultiplier);
	return round(clamp01(raw));
}

/**
 * Bubblemap connectivity: share of distinct buyer wallets funded from a common
 * source. Requires walletMeta with `funder`. Returns null when unavailable —
 * never a fabricated number.
 */
export function bubblemapConnectivity(walletAgg, walletMeta) {
	if (!walletMeta || walletMeta.size === 0) return null;
	const funders = new Map();
	let known = 0;
	for (const wallet of walletAgg.keys()) {
		const meta = walletMeta.get(wallet);
		const f = meta?.funder;
		if (!f) continue;
		known++;
		funders.set(f, (funders.get(f) || 0) + 1);
	}
	if (known < 3) return null;
	const biggestCluster = Math.max(...funders.values());
	return round(clamp01(biggestCluster / known));
}

/**
 * Fresh-wallet ratio: share of buyers whose wallet had ~no prior history.
 * Requires walletMeta with priorTxCount. Null when unavailable.
 */
export function freshWalletRatio(walletAgg, walletMeta) {
	if (!walletMeta || walletMeta.size === 0) return null;
	let known = 0;
	let fresh = 0;
	for (const wallet of walletAgg.keys()) {
		const meta = walletMeta.get(wallet);
		if (meta?.priorTxCount == null) continue;
		known++;
		if (meta.priorTxCount <= 1) fresh++;
	}
	if (known < 3) return null;
	return round(fresh / known);
}

/**
 * The full signal computation. Returns a structured object.
 */
export function computeSignals(observation) {
	const trades = Array.isArray(observation.trades) ? observation.trades : [];
	const walletAgg = aggregateWallets(trades);

	const buys = trades.filter((t) => t.isBuy);
	const sells = trades.filter((t) => !t.isBuy);
	const buyLamports = sum(buys.map((b) => Number(b.lamports) || 0));
	const sellLamports = sum(sells.map((s) => Number(s.lamports) || 0));

	const uniqueBuyers = new Set(buys.map((b) => b.trader).filter(Boolean)).size;
	const uniqueSellers = new Set(sells.map((s) => s.trader).filter(Boolean)).size;
	const uniqueTraders = walletAgg.size;

	const buySols = buys.map((b) => lamportsToSol(b.lamports)).filter((x) => x > 0);
	const largestBuyLamports = buys.length ? Math.max(...buys.map((b) => Number(b.lamports) || 0)) : 0;
	const avgBuySol = buySols.length ? sum(buySols) / buySols.length : 0;
	const medianBuySol = median(buySols);

	// Snipe ratio: share of buy volume that landed in the first SNIPE_MS.
	let snipeRatio = 0;
	if (buys.length && buyLamports > 0) {
		const t0 = Math.min(...buys.map((b) => b.ts));
		const early = sum(buys.filter((b) => b.ts - t0 <= SNIPE_MS).map((b) => Number(b.lamports) || 0));
		snipeRatio = clamp01(early / buyLamports);
	}

	// Concentration: per-wallet NET buy (buy − sell, floored at 0) share of total.
	const netBuys = [];
	for (const w of walletAgg.values()) {
		const net = Math.max(0, w.buyLamports - w.sellLamports);
		if (net > 0) netBuys.push(net);
	}
	netBuys.sort((a, b) => b - a);
	const totalNet = sum(netBuys) || 0;
	const shareOfTop = (k) => (totalNet > 0 ? clamp01(sum(netBuys.slice(0, k)) / totalNet) : 0);
	const concentrationTop1 = shareOfTop(1);
	const concentrationTop5 = shareOfTop(5);
	const concentrationTop10 = shareOfTop(10);

	// Arrival-time entropy across 1s buckets — organic flow is spread out.
	let timingEntropy = 0;
	if (buys.length > 2) {
		const t0 = Math.min(...buys.map((b) => b.ts));
		const span = Math.max(1, Math.max(...buys.map((b) => b.ts)) - t0);
		const bucketCount = Math.min(30, Math.max(2, Math.ceil(span / 1000)));
		const counts = new Array(bucketCount).fill(0);
		for (const b of buys) {
			const idx = Math.min(bucketCount - 1, Math.floor(((b.ts - t0) / span) * bucketCount));
			counts[idx]++;
		}
		timingEntropy = normalizedEntropy(counts);
	}

	// Dev behavior.
	const devBuyLamports = observation.devBuyLamports != null ? Number(observation.devBuyLamports) : null;
	const creator = observation.creator;
	const creatorAgg = creator ? walletAgg.get(creator) : null;
	const devSellLamports = creatorAgg ? creatorAgg.sellLamports : 0;
	const devSold = !!(creatorAgg && creatorAgg.sellCount > 0 && devSellLamports > 0);
	const devBuySol = devBuyLamports != null ? lamportsToSol(devBuyLamports) : null;

	// Optional wallet-graph enrichment.
	const bubblemap = bubblemapConnectivity(walletAgg, observation.walletMeta);
	const freshRatio = freshWalletRatio(walletAgg, observation.walletMeta);

	const bundle = bundleScore(trades);

	// Organic score: high buyer diversity, even arrival timing, low clustering,
	// dev not dumping, no single whale. Blend of positives minus the bundle tell.
	const diversity = uniqueBuyers >= 10 ? 1 : uniqueBuyers / 10;
	const whalePenalty = concentrationTop1; // 1 wallet owning everything is bad
	let organic = (
		diversity * 0.30 +
		timingEntropy * 0.25 +
		(1 - bundle) * 0.25 +
		(1 - clamp01(snipeRatio)) * 0.10 +
		(1 - whalePenalty) * 0.10
	);
	if (devSold) organic *= 0.6;            // dev dumping is a hard organic killer
	if (freshRatio != null) organic *= (1 - 0.4 * freshRatio); // fresh-wallet swarm
	organic = clamp01(organic);

	const buySellRatio = sellLamports > 0 ? buyLamports / sellLamports : (buyLamports > 0 ? Infinity : 0);

	const signals = {
		window_seconds: observation.endedAtMs && observation.firstSeenAtMs
			? Math.round((observation.endedAtMs - observation.firstSeenAtMs) / 1000) : null,
		trade_count: trades.length,
		buy_count: buys.length,
		sell_count: sells.length,
		buy_volume_sol: round(lamportsToSol(buyLamports), 4),
		sell_volume_sol: round(lamportsToSol(sellLamports), 4),
		net_volume_sol: round(lamportsToSol(buyLamports - sellLamports), 4),
		buy_sell_ratio: Number.isFinite(buySellRatio) ? round(buySellRatio, 2) : null,
		unique_buyers: uniqueBuyers,
		unique_sellers: uniqueSellers,
		unique_traders: uniqueTraders,
		largest_buy_sol: round(lamportsToSol(largestBuyLamports), 4),
		avg_buy_sol: round(avgBuySol, 4),
		median_buy_sol: round(medianBuySol, 4),

		bundle_score: bundle,
		snipe_ratio: round(snipeRatio),
		organic_score: round(organic),
		coordination_score: round(clamp01(bundle * 0.6 + (bubblemap ?? 0) * 0.4)),
		timing_entropy: round(timingEntropy),

		concentration_top1: round(concentrationTop1),
		concentration_top5: round(concentrationTop5),
		concentration_top10: round(concentrationTop10),

		fresh_wallet_ratio: freshRatio,
		bubblemap_connectivity: bubblemap,

		dev_buy_sol: devBuySol != null ? round(devBuySol, 4) : null,
		dev_sold: devSold,
		dev_sell_sol: round(lamportsToSol(devSellLamports), 4),
	};

	const risk = summarizeRisk(signals);
	return { signals, ...risk, walletAgg };
}

/**
 * Reduce signals to a 0..100 quality score and a list of human-readable risk
 * flags. The score is intentionally simple and transparent — the learned
 * weights in learn.js refine ranking; this is the always-available baseline.
 */
export function summarizeRisk(signals) {
	const flags = [];
	if (signals.bundle_score >= 0.6) flags.push('bundle_launch');
	if (signals.dev_sold) flags.push('dev_dumped');
	if (signals.concentration_top1 >= 0.5) flags.push('single_whale');
	if (signals.unique_buyers > 0 && signals.unique_buyers < 5) flags.push('low_diversity');
	if (signals.fresh_wallet_ratio != null && signals.fresh_wallet_ratio >= 0.7) flags.push('fresh_wallet_swarm');
	if (signals.buy_sell_ratio != null && signals.buy_sell_ratio < 1 && signals.sell_count >= 3) flags.push('sell_pressure');
	if (signals.snipe_ratio >= 0.85 && signals.unique_buyers < 8) flags.push('sniped');

	// Quality score: start from organic, penalize each risk dimension. Clamp 0..100.
	let q = (signals.organic_score ?? 0) * 100;
	q -= signals.bundle_score * 40;
	q -= signals.concentration_top1 * 25;
	if (signals.dev_sold) q -= 25;
	if (signals.fresh_wallet_ratio != null) q -= signals.fresh_wallet_ratio * 20;
	// Reward genuine breadth.
	q += Math.min(15, (signals.unique_buyers || 0) * 0.5);
	const quality = Math.max(0, Math.min(100, Math.round(q)));

	return { quality_score: quality, risk_flags: flags };
}

export const _internals = { normalizedEntropy, median, BURST_MS, SNIPE_MS, LAMPORTS_PER_SOL };
