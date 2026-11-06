// GET /api/leaderboard  — public $THREE holder leaderboard (clean, paginated)
// --------------------------------------------------------------------------
// The canonical holder board for /leaderboard's "$THREE Holders" view. It serves
// the cached $THREE holder snapshot (api/_lib/coin/three-holders.js, refreshed by
// the three-holders-snapshot cron — falling back to a live Helius DAS scan only on
// a cold cache) and the live market module (price / supply / holder count), then
// derives a holder TIER from each wallet's on-chain balance so the page can render
// badges and gate the 3D PFP generator without re-deriving thresholds client-side.
//
// Query params:
//   ?limit=<1..100>   page size           (default 50)
//   ?offset=<n>       page offset          (default 0)
//   ?wallet=<base58>  optional — also returns this wallet's own rank + tier even
//                     when it falls outside the requested page, so a connected
//                     holder always sees "you are #N".
//
// Response:
//   {
//     holders: [{ rank, wallet, wallet_short, amount, pct_of_supply, tier }],
//     total, limit, offset, supply, mint, decimals,
//     tiers: [{ id, label, min, accent }],        // tier ladder (for the legend)
//     market: { price_usd, market_cap, holders }, // live, for the header strip
//     you: { rank, amount, pct_of_supply, tier } | null,
//     ts
//   }
//
// Never 500s a public board: a Helius outage / missing key returns an empty,
// well-formed board so the page renders its empty state instead of an error.

import { cors, json, method, wrap } from './_lib/http.js';
import { TOKEN_MINT as THREE_MINT } from './_lib/token/config.js';
import { fetchTokenMarketData } from './_lib/market/token-market.js';
import { threeHolderBalances } from './_lib/coin/three-holders.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// $THREE holder tier ladder — derived purely from on-chain balance. Thresholds
// ascend by ~10× so the tiers read as clear membership bands (whole-token
// amounts). The same ladder is mirrored in public/leaderboard-holders.js (badge
// styling) and api/og-leaderboard.js (share-card accent) so a holder's tier is
// consistent across the board, the 3D badge, and the OG card.
const HOLDER_TIERS = [
	{ id: 'genesis', label: 'Genesis', min: 10_000_000, accent: '#f5d0a9' },
	{ id: 'diamond', label: 'Diamond', min: 1_000_000, accent: '#7dd3fc' },
	{ id: 'platinum', label: 'Platinum', min: 100_000, accent: '#c4b5fd' },
	{ id: 'gold', label: 'Gold', min: 10_000, accent: '#fbbf24' },
	{ id: 'silver', label: 'Silver', min: 1_000, accent: '#cbd5e1' },
	{ id: 'bronze', label: 'Bronze', min: 1, accent: '#d8a07a' },
	{ id: 'none', label: 'Not holding', min: 0, accent: '#6b7280' },
];

function tierForBalance(amount) {
	const n = Number(amount) || 0;
	for (const t of HOLDER_TIERS) {
		if (n >= t.min && t.min > 0) return t;
	}
	return HOLDER_TIERS[HOLDER_TIERS.length - 1];
}

function shortWallet(addr) {
	const s = String(addr || '');
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
	const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
	const wallet = (url.searchParams.get('wallet') || '').trim();
	const wantWallet = BASE58_RE.test(wallet) ? wallet : null;

	const tiers = HOLDER_TIERS.map((t) => ({ id: t.id, label: t.label, min: t.min, accent: t.accent }));

	try {
		// Real holder set (every $THREE holder across both token programs) + live
		// market data for supply → % of supply and the header price strip. Both are
		// independently resilient: a market blip just nulls the percentages.
		// Holders come from the cached snapshot (refreshed by the
		// three-holders-snapshot cron); only a cold/stale cache live-scans Helius.
		const [balances, market] = await Promise.all([
			threeHolderBalances(),
			fetchTokenMarketData(THREE_MINT).catch(() => null),
		]);

		const decimals = Number(market?.decimals ?? 6);
		const atomicsPerToken = 10 ** decimals;
		const supply = market?.supply != null ? Number(market.supply) : null;

		// Rank by exact atomic balance (BigInt) so whales past Number's 2^53 ceiling
		// still order correctly; convert to display Number only for emitted rows.
		const ranked = [...balances.entries()]
			.filter(([, atomic]) => atomic > 0n)
			.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));

		const total = ranked.length;
		const toRow = (entry, idx) => {
			const [w, atomic] = entry;
			const amount = Number(atomic) / atomicsPerToken;
			return {
				rank: idx + 1,
				wallet: w,
				wallet_short: shortWallet(w),
				amount,
				pct_of_supply: supply ? amount / supply : null,
				tier: tierForBalance(amount).id,
			};
		};

		const holders = ranked
			.slice(offset, offset + limit)
			.map((entry, i) => toRow(entry, offset + i));

		// Connected wallet's own standing — even outside the page window.
		let you = null;
		if (wantWallet) {
			const idx = ranked.findIndex(([w]) => w === wantWallet);
			if (idx >= 0) {
				const row = toRow(ranked[idx], idx);
				you = { rank: row.rank, amount: row.amount, pct_of_supply: row.pct_of_supply, tier: row.tier };
			} else {
				you = { rank: null, amount: 0, pct_of_supply: 0, tier: tierForBalance(0).id };
			}
		}

		return json(
			res,
			200,
			{
				holders,
				total,
				limit,
				offset,
				supply,
				mint: THREE_MINT,
				decimals,
				tiers,
				market: market
					? {
							price_usd: market.price_usd ?? null,
							market_cap: market.market_cap ?? null,
							holders: market.holders ?? null,
						}
					: null,
				you,
				ts: Date.now(),
			},
			// Holder sets change slowly; the Helius scan is seconds + thousands of
			// accounts, so cache at the edge and run it at most ~once a minute.
			{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
		);
	} catch (err) {
		console.error('[leaderboard]', err?.message || err);
		return json(
			res,
			200,
			{
				holders: [],
				total: 0,
				limit,
				offset,
				supply: null,
				mint: THREE_MINT,
				decimals: 6,
				tiers,
				market: null,
				you: wantWallet ? { rank: null, amount: 0, pct_of_supply: 0, tier: tierForBalance(0).id } : null,
				ts: Date.now(),
			},
			{ 'cache-control': 'public, s-maxage=30' },
		);
	}
});
