/**
 * pump/smart-money-score.js
 * -------------------------
 * Pure: score a live coin by the PEDIGREE of the money buying it. Given the
 * coin's per-wallet buys and a reputation map (wallet → {smart_money_score,
 * label}), produce a 0..100 "is proven money accumulating this" signal plus the
 * notable wallets driving it. This is what the radar ranks on and what a
 * follow-the-smart-money sniper would gate on.
 */

// A wallet at/above this reputation counts as "proven smart money".
export const SMART_THRESHOLD = 70;

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {Array<{wallet:string, buy_lamports:number, is_creator?:boolean}>} wallets  buyers in this coin
 * @param {Map<string,{smart_money_score:number,label:string}>|object} repMap
 * @param {{smartThreshold?:number}} [opts]
 * @returns {{ smart_money_score, smart_wallet_count, proven_buy_lamports, total_buy_lamports, notable }}
 */
export function computeCoinSmartMoney(wallets, repMap, opts = {}) {
	const threshold = opts.smartThreshold ?? SMART_THRESHOLD;
	const lookup = repMap instanceof Map ? (w) => repMap.get(w) : (w) => repMap?.[w];
	const rows = Array.isArray(wallets) ? wallets : [];

	let total_buy = 0;
	let proven_buy = 0;
	let weightedScoreSum = 0; // Σ rep.score · buy
	let smart_wallet_count = 0;
	const ranked = [];

	for (const r of rows) {
		const buy = num(r.buy_lamports);
		if (buy <= 0 || r.is_creator) continue; // creators don't lend pedigree to their own coin
		total_buy += buy;
		const rep = lookup(r.wallet);
		const score = rep ? num(rep.smart_money_score) : 0;
		weightedScoreSum += score * buy;
		if (score >= threshold) {
			proven_buy += buy;
			smart_wallet_count++;
		}
		if (rep && score > 0) {
			ranked.push({ wallet: r.wallet, label: rep.label || 'neutral', score, buy_sol: lamportsToSol(buy) });
		}
	}

	// Pedigree = buy-weighted average reputation of the money in the coin
	// (unknown wallets score 0 and correctly drag it down), with a bounded
	// network-effect bonus for each additional proven wallet piling in.
	const weightedAvg = total_buy > 0 ? weightedScoreSum / total_buy : 0;
	const networkBonus = Math.min(smart_wallet_count, 5) * 4;
	const smart_money_score = Math.round(clamp(weightedAvg + networkBonus, 0, 100) * 10) / 10;

	ranked.sort((a, b) => b.score - a.score || b.buy_sol - a.buy_sol);

	return {
		smart_money_score,
		smart_wallet_count,
		proven_buy_lamports: Math.round(proven_buy),
		total_buy_lamports: Math.round(total_buy),
		notable: ranked.slice(0, 8),
	};
}

function lamportsToSol(l) {
	return Math.round((num(l) / 1e9) * 1000) / 1000;
}
