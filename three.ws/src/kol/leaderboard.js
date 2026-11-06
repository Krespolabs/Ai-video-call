// KOL leaderboard — live, kolscan-backed.
//
// Source of truth: the real kolscan.io leaderboard of top Solana traders, fetched
// and parsed by ./kolscan-live.js (one HTML GET yields the 24h / 7d / 30d boards,
// priced SOL→USD from the live feed). The scoring shape is the address-keyed
// { wallet, pnlUsd, winRate, trades, rank } the KOL surfaces and the public
// /api/kol/leaderboard endpoint already speak.
//
// Honest degradation: if the live source is unreachable (network, bot-challenge,
// layout change, price-feed outage), the board returns empty rather than stale or
// fabricated rows — callers render an honest empty state. The live fetcher is
// injectable so tests exercise the real parse/scoring path deterministically.

import { fetchKolscanLeaderboard } from './kolscan-live.js';

const VALID_WINDOWS = new Set(['24h', '7d', '30d']);

/**
 * @param {object} opts
 * @param {'24h'|'7d'|'30d'} [opts.window]
 * @param {number} [opts.limit]
 * @param {() => Promise<null | Record<string, Array>>} [opts.fetchLive]
 *   Live source override (tests inject a fixture). Defaults to kolscan.
 * @returns {Promise<Array<{ wallet: string, pnlUsd: number, winRate: number, trades: number, rank: number }>>}
 */
export async function getLeaderboard({
	window = '7d',
	limit = 25,
	fetchLive = fetchKolscanLeaderboard,
} = {}) {
	if (!VALID_WINDOWS.has(window)) {
		const err = new Error(`invalid window "${window}": must be 24h, 7d, or 30d`);
		err.status = 400;
		err.code = 'invalid_window';
		throw err;
	}

	const cap = Math.min(Math.max(1, Math.floor(Number(limit) || 25)), 100);

	const board = await fetchLive().catch(() => null);
	const rows = board?.[window];
	if (!Array.isArray(rows)) return [];

	return rows
		.filter((r) => r && typeof r.wallet === 'string' && Number.isFinite(r.pnlUsd))
		.map((r) => ({
			wallet: r.wallet,
			pnlSol: Number.isFinite(r.pnlSol) ? r.pnlSol : null,
			pnlUsd: r.pnlUsd,
			winRate: Number(r.winRate) || 0,
			trades: Number(r.trades) || 0,
		}))
		.sort((a, b) => b.pnlUsd - a.pnlUsd)
		.slice(0, cap)
		.map((item, i) => ({ ...item, rank: i + 1 }));
}
