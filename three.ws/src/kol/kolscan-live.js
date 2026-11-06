// Live KOL leaderboard — kolscan.io.
//
// kolscan.io publishes a real, public leaderboard of named Solana traders ranked
// by realized SOL profit over a daily / weekly / monthly window. Its JSON API is
// auth-gated, but the /leaderboard page server-renders ALL THREE windows into its
// Next.js flight data in a single response — so one HTML GET yields the full
// board. This module fetches it, parses the embedded `initLeaderboard` array, and
// maps it onto the wallet-centric shape the KOL surfaces already speak
// ({ wallet, pnlSol, pnlUsd, winRate, trades }).
//
// We deliberately drop the trader names/handles kolscan attaches: the existing
// leaderboard schema is address-keyed, and surfacing arbitrary third-party social
// handles is neither needed nor something we want to render verbatim.
//
// Honest degradation (mirrors gmgn-feed.js / smart-money.js): a network error,
// a bot-challenge, a layout change, or a price-feed outage resolves to `null`,
// never a throw and never fabricated rows — the caller decides how to degrade.
//
// Coin-agnostic analytics over real on-chain traders. $THREE is the only coin
// three.ws promotes; this reads wallets + realized PnL, no token is referenced.

import { solToUsd } from '../shared/usd-price.js';
import { cacheGet, cacheSet } from '../../api/_lib/cache.js';

const LEADERBOARD_URL = 'https://kolscan.io/leaderboard';
const FETCH_TIMEOUT_MS = 9_000;
const CACHE_KEY = 'kol:kolscan:leaderboard:v1';
const CACHE_TTL_S = 120; // the board moves slowly; spare the upstream + the edge

// kolscan's `timeframe` field → the window vocabulary the KOL surfaces use.
const TIMEFRAME_TO_WINDOW = { 1: '24h', 7: '7d', 30: '30d' };

const BROWSER_HEADERS = {
	'user-agent':
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'accept-language': 'en-US,en;q=0.9',
	referer: 'https://kolscan.io/',
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Reassemble the Next.js RSC flight stream the page ships as a series of
// `self.__next_f.push([1,"<escaped-json-string>"])` calls. Each call's payload is
// a JSON string literal; decoding and concatenating them yields the full blob the
// server rendered, which contains the `initLeaderboard` array verbatim.
function decodeFlight(html) {
	const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
	let blob = '';
	let m;
	while ((m = re.exec(html)) !== null) {
		try {
			blob += JSON.parse(`"${m[1]}"`);
		} catch {
			/* skip a malformed chunk rather than abandon the whole parse */
		}
	}
	return blob;
}

// Pull the JSON array that follows a `"<key>":` marker via brace/bracket matching,
// so embedded strings or nested arrays can't truncate it the way a greedy regex
// would. Returns the parsed array, or null if the marker/array isn't well-formed.
function extractJsonArray(blob, key) {
	const at = blob.indexOf(`"${key}":`);
	if (at === -1) return null;
	const start = blob.indexOf('[', at);
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < blob.length; i++) {
		const ch = blob[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === '\\') esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === '[') depth++;
		else if (ch === ']' && --depth === 0) {
			try {
				return JSON.parse(blob.slice(start, i + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

/**
 * Parse a kolscan /leaderboard HTML document into per-window rows. Pure: no I/O,
 * no USD pricing (that needs a live feed) — just the SOL-denominated truth the
 * page rendered. Returns null when the leaderboard payload can't be found.
 *
 * @param {string} html
 * @returns {null | { '24h': Row[], '7d': Row[], '30d': Row[] }}
 *   Row = { wallet, pnlSol, winRate, trades }
 */
export function parseKolscanLeaderboard(html) {
	if (typeof html !== 'string' || html.length === 0) return null;
	const blob = decodeFlight(html);
	const entries = extractJsonArray(blob, 'initLeaderboard');
	if (!Array.isArray(entries) || entries.length === 0) return null;

	const windows = { '24h': [], '7d': [], '30d': [] };
	for (const e of entries) {
		const window = TIMEFRAME_TO_WINDOW[e?.timeframe];
		const wallet = e?.wallet_address;
		if (!window || typeof wallet !== 'string' || wallet.length < 32) continue;
		const wins = num(e.wins);
		const losses = num(e.losses);
		const trades = wins + losses;
		windows[window].push({
			wallet,
			pnlSol: num(e.profit),
			winRate: trades > 0 ? wins / trades : 0,
			trades,
		});
	}
	// A payload that parsed but yielded no usable rows is a layout change, not data.
	if (!windows['24h'].length && !windows['7d'].length && !windows['30d'].length) return null;
	return windows;
}

// Attach a USD figure to every row from a single live SOL/USD read. If the price
// feed is down, solToUsd returns null and we surface pnlUsd: null — the caller
// treats a board with no USD as "no live data" and degrades accordingly.
async function priceWindows(windows) {
	const solPrice = await solToUsd(1); // dollars per 1 SOL, or null on feed outage
	const apply = (rows) =>
		rows.map((r) => ({ ...r, pnlUsd: solPrice == null ? null : r.pnlSol * solPrice }));
	return { '24h': apply(windows['24h']), '7d': apply(windows['7d']), '30d': apply(windows['30d']) };
}

/**
 * Fetch the live kolscan leaderboard for all windows, priced in USD, cached
 * briefly. Resolves to null on any failure (network, challenge, parse, pricing).
 *
 * @returns {Promise<null | { '24h': Row[], '7d': Row[], '30d': Row[] }>}
 *   Row = { wallet, pnlSol, pnlUsd, winRate, trades }
 */
export async function fetchKolscanLeaderboard() {
	const cached = await cacheGet(CACHE_KEY).catch(() => null);
	if (cached) return cached;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	let html;
	try {
		const res = await fetch(LEADERBOARD_URL, { headers: BROWSER_HEADERS, signal: ctrl.signal });
		if (!res.ok) return null;
		html = await res.text();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}

	const parsed = parseKolscanLeaderboard(html);
	if (!parsed) return null;

	const priced = await priceWindows(parsed);
	await cacheSet(CACHE_KEY, priced, CACHE_TTL_S).catch(() => {});
	return priced;
}
