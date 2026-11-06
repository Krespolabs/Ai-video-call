// Smart-money cross-reference for the Coin Intelligence Engine.
//
// At intel-finalize time the watcher passes us the full list of wallets that
// bought the coin. We run ONE batched DB query against wallet_reputation and
// return:
//   count      — # of "proven" buyers (smart_money_score >= 65)
//   score      — pedigree-weighted composite (0..100): how much proven money is in this coin
//   notable    — top 5 proven buyers with their label + win_rate + buy_sol
//   top_label  — highest-reputation label seen ('smart_money' | 'sniper' | ...)
//
// This is the "smart money just bought" signal. It's the highest-predictive
// single feature in the engine. It runs on EVERY coin in the decision window.
//
// The DB import is lazy — the worker imports this before DATABASE_URL is
// necessarily set, and we return safe zeros rather than crashing.

const SMART_THRESHOLD = 65; // wallet_reputation.smart_money_score >= this → proven
const NOTABLE_LIMIT = 5;

let _sqlPromise = null;
async function getSql() {
	if (_sqlPromise) return _sqlPromise;
	_sqlPromise = import('../db.js')
		.then((m) => m.sql)
		.catch((err) => { console.warn('[smart-money-xref] db import failed:', err?.message); return null; });
	return _sqlPromise;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Cross-reference a list of buyer wallets against wallet_reputation.
 * Returns { count, score, notable, top_label }.
 *
 * @param {string[]} wallets  buyer wallet addresses observed in this coin
 * @param {string} [network]
 * @returns {Promise<{ count: number, score: number|null, notable: object[], top_label: string|null }>}
 */
export async function crossReferenceSmartMoney(wallets, network = 'mainnet') {
	const unique = [...new Set((wallets || []).filter(Boolean))];
	const empty = { count: 0, score: null, notable: [], top_label: null };
	if (!unique.length) return empty;

	const sql = await getSql();
	if (!sql) return empty;

	try {
		const rows = await sql`
			select wallet, smart_money_score, label, win_rate, early_win_rate, wins, duds
			from wallet_reputation
			where network = ${network}
			  and wallet = any(${unique})
			  and smart_money_score >= ${SMART_THRESHOLD}
			order by smart_money_score desc
			limit ${NOTABLE_LIMIT * 2}
		`;

		if (!rows.length) return empty;

		const proven = rows.filter((r) => Number(r.smart_money_score) >= SMART_THRESHOLD);
		if (!proven.length) return empty;

		// Pedigree-weighted composite: sum(score * win_rate) / n, normalised to 0..100
		let weightedSum = 0;
		let totalWeight = 0;
		for (const r of proven) {
			const s = Number(r.smart_money_score) || 0;
			const w = Math.max(0.1, Number(r.win_rate) || 0.1);
			weightedSum += s * w;
			totalWeight += w;
		}
		const compositeScore = totalWeight > 0
			? Math.min(100, Math.round(weightedSum / totalWeight))
			: null;

		const topLabel = proven[0]?.label || null;

		const notable = proven.slice(0, NOTABLE_LIMIT).map((r) => ({
			wallet: r.wallet,
			label: r.label,
			smart_money_score: Number(r.smart_money_score),
			win_rate: r.win_rate != null ? Math.round(Number(r.win_rate) * 1000) / 1000 : null,
			wins: Number(r.wins) || 0,
			duds: Number(r.duds) || 0,
		}));

		return {
			count: proven.length,
			score: compositeScore,
			notable,
			top_label: topLabel,
		};
	} catch (err) {
		console.warn('[smart-money-xref] query failed:', err?.message);
		return empty;
	}
}

/**
 * Lightweight version for use in the live sniper scorer (called on every mint
 * before the full intel window closes). Cheaper: only looks up the dev wallet
 * and the first few buyers, returns boolean + top hit.
 *
 * @param {string[]} wallets  up to 20 wallets
 * @param {string} [network]
 * @returns {Promise<{ hasSmartMoney: boolean, topWallet: object|null }>}
 */
export async function quickSmartMoneyCheck(wallets, network = 'mainnet') {
	const unique = [...new Set((wallets || []).filter(Boolean))].slice(0, 20);
	if (!unique.length) return { hasSmartMoney: false, topWallet: null };

	const sql = await getSql();
	if (!sql) return { hasSmartMoney: false, topWallet: null };

	try {
		const [top] = await sql`
			select wallet, smart_money_score, label, win_rate
			from wallet_reputation
			where network = ${network}
			  and wallet = any(${unique})
			  and smart_money_score >= ${SMART_THRESHOLD}
			order by smart_money_score desc
			limit 1
		`;
		if (!top) return { hasSmartMoney: false, topWallet: null };
		return {
			hasSmartMoney: true,
			topWallet: {
				wallet: top.wallet,
				label: top.label,
				smart_money_score: Number(top.smart_money_score),
				win_rate: top.win_rate != null ? Number(top.win_rate) : null,
			},
		};
	} catch {
		return { hasSmartMoney: false, topWallet: null };
	}
}
