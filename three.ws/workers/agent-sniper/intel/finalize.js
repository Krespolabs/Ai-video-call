// Coin Intelligence — observation finalization.
//
// Turns a finished observation (a coin's first seconds of trading, captured by
// either the always-on watcher or the serverless cron observer) into a complete
// intel record: deterministic signals → parallel enrichment → persisted row.
//
// Extracted from watcher.js so the long-running worker and the Vercel cron
// (api/cron/coin-intel-observe.js) share ONE finalize path — no duplicated
// scoring/classification logic that could drift between the two producers.
//
// Observation shape (built by the producer):
//   {
//     mint, creator,
//     createdAtSec, firstSeenAtMs,
//     devBuyLamports, mcSolFirstSeen,
//     meta: { name, symbol, bonding_curve, image_uri, description, twitter, telegram, website },
//     trades: [ { trader, isBuy, lamports, baseAmount, ts, signature } ],
//   }

import { computeSignals } from './signals.js';
import { classifyCoin } from './classify.js';
import { persistIntel } from './store.js';
import { resolveWalletFunders, buildClusters } from '../../../api/_lib/pump-intel/funder-graph.js';
import { crossReferenceSmartMoney } from '../../../api/_lib/pump-intel/smart-money-xref.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const solToLamports = (sol) => Math.round((Number(sol) || 0) * LAMPORTS_PER_SOL);

// Recompute quality score incorporating smart-money signal. Smart money entering
// early is the strongest positive signal we have.
function recomputeQuality(baseScore, signals, smartMoneyCount) {
	let q = baseScore;
	if (smartMoneyCount >= 1) q += 8;
	if (smartMoneyCount >= 2) q += 6;
	if (smartMoneyCount >= 3) q += 4;
	// connectivity penalty already applied to organic_score; don't double-count.
	return Math.max(0, Math.min(100, Math.round(q)));
}

/**
 * Finalize one observation into a persisted intel record.
 * @param {object} obs        the observation assembled by the producer
 * @param {object} [opts]
 * @param {string} [opts.network='mainnet']
 * @param {boolean} [opts.useLlm=false]  enable LLM classification refinement
 * @param {number} [opts.endedAtMs]      observation end (defaults to now)
 * @returns {Promise<object>} the persisted record
 */
export async function finalizeObservation(obs, { network = 'mainnet', useLlm = false, endedAtMs } = {}) {
	const ended = endedAtMs || Date.now();

	// ── Phase 1: deterministic signal computation (sync, no I/O) ─────────────
	const { signals, quality_score, risk_flags, walletAgg } = computeSignals({
		mint: obs.mint,
		creator: obs.creator,
		createdAtMs: obs.firstSeenAtMs,
		firstSeenAtMs: obs.firstSeenAtMs,
		endedAtMs: ended,
		devBuyLamports: obs.devBuyLamports,
		trades: obs.trades,
	});
	if (obs.mcSolFirstSeen != null) signals.mc_sol_first_seen = obs.mcSolFirstSeen;

	// ── Phase 2: parallel enrichment (network I/O, best-effort) ──────────────
	const buyerWallets = [...walletAgg.keys()].filter((w) => {
		const a = walletAgg.get(w);
		return a && a.buyCount > 0;
	});

	const [cls, funderMap, smartMoneyResult] = await Promise.allSettled([
		classifyCoin({
			name: obs.meta.name,
			symbol: obs.meta.symbol,
			description: obs.meta.description,
			twitter: obs.meta.twitter,
			telegram: obs.meta.telegram,
			website: obs.meta.website,
		}, { useLlm }),
		resolveWalletFunders(buyerWallets.slice(0, 60)),
		crossReferenceSmartMoney(buyerWallets, network),
	]);

	const classification = cls.status === 'fulfilled' ? cls.value
		: { category: 'unknown', tags: [], narrative: null, is_news_meme: false, confidence: 0.15, source: 'heuristic' };

	const resolvedFunders = funderMap.status === 'fulfilled' ? funderMap.value : new Map();
	const { clusters, connectivity } = buildClusters(resolvedFunders);

	const smartMoney = smartMoneyResult.status === 'fulfilled' ? smartMoneyResult.value
		: { count: 0, notable: [], top_label: null };

	for (const [wallet, funder] of resolvedFunders) {
		const entry = walletAgg.get(wallet);
		if (entry) entry.funder = funder || null;
	}

	// ── Phase 3: upgrade signals with enrichment results ─────────────────────
	if (connectivity != null) signals.bubblemap_connectivity = connectivity;
	signals.smart_money_count = smartMoney.count;
	signals.smart_money_score = smartMoney.score ?? null;
	if (connectivity != null) {
		const existing = signals.organic_score ?? 0;
		signals.organic_score = Math.max(0, Math.min(1,
			existing * (1 - 0.3 * connectivity) + (smartMoney.count > 0 ? 0.05 * Math.min(smartMoney.count, 3) : 0)
		));
		signals.organic_score = Math.round(signals.organic_score * 10000) / 10000;
	}
	if (connectivity != null && connectivity >= 0.4 && !risk_flags.includes('coordinated_cluster')) {
		risk_flags.push('coordinated_cluster');
	}

	const record = {
		mint: obs.mint,
		network,
		symbol: obs.meta.symbol,
		name: obs.meta.name,
		creator: obs.creator,
		bonding_curve: obs.meta.bonding_curve,
		image_uri: obs.meta.image_uri,
		description: obs.meta.description,
		twitter: obs.meta.twitter,
		telegram: obs.meta.telegram,
		website: obs.meta.website,
		created_at_sec: obs.createdAtSec,
		first_seen_at_ms: obs.firstSeenAtMs,
		dev_buy_lamports: obs.devBuyLamports,
		dev_sell_lamports: solToLamports(signals.dev_sell_sol || 0),
		buy_volume_lamports: solToLamports(signals.buy_volume_sol || 0),
		sell_volume_lamports: solToLamports(signals.sell_volume_sol || 0),
		largest_buy_lamports: solToLamports(signals.largest_buy_sol || 0),
		signals,
		quality_score: recomputeQuality(quality_score, signals, smartMoney.count),
		risk_flags,
		category: classification.category,
		tags: classification.tags,
		narrative: classification.narrative,
		is_news_meme: classification.is_news_meme,
		classify_confidence: classification.confidence,
		classify_source: classification.source,
		smart_money_count: smartMoney.count,
		smart_money_score: smartMoney.score ?? null,
		smart_money_notable: smartMoney.notable,
		cluster_count: clusters.size,
		bubblemap_connectivity: connectivity,
	};

	await persistIntel(record, walletAgg);
	return { record, summary: { connectivity, clusters: clusters.size, buyers: buyerWallets.length, smartMoney: smartMoney.count } };
}
