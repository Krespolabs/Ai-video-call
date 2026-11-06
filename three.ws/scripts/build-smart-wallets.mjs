#!/usr/bin/env node
/**
 * Build api/_lib/copy/smart-wallets.json — the Smart Money directory that powers
 * the /dashboard/copy "Smart Money" section.
 *
 * Source: local kol-quest-format scrapes (smart_degen, launchpad_smart, snipe_bot,
 * top_followed, top_renamed, kol) for Solana and BSC. These are the same shape
 * GMGN exposes; nirholas/scrape-smart-wallets produces them.
 *
 *   node scripts/build-smart-wallets.mjs                 # reads ./solwallets.json + ./bscwallets.json
 *   node scripts/build-smart-wallets.mjs sol.json bsc.json
 *   node scripts/build-smart-wallets.mjs --dry           # print stats, don't write
 *
 * Distilled, deduplicated, ranked. WALLET ADDRESSES + IDENTITY + PERFORMANCE ONLY —
 * never token mints (the platform references only $THREE). A wallet appearing in
 * several buckets is merged into one row carrying every tag it earned.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../api/_lib/copy/smart-wallets.json');
const DRY = process.argv.includes('--dry');

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SOURCES = [
	{ file: positional[0] || path.join(__dirname, '../solwallets.json'), chain: 'sol' },
	{ file: positional[1] || path.join(__dirname, '../bscwallets.json'), chain: 'bsc' },
];

// gmgn/kol-quest bucket → our category. Buckets that aren't a proven edge signal
// (fresh wallets, "live" snapshots, unverified top_dev) are dropped: a directory
// users copy from must only carry wallets with a real, legible track record.
const BUCKET_CATEGORY = {
	smart_degen: 'smart_money',
	top_followed: 'smart_money',
	top_renamed: 'smart_money',
	launchpad_smart: 'launchpad',
	snipe_bot: 'sniper',
	kol: 'kol',
};
// When a wallet earns several categories, this is the one we surface as primary.
const CATEGORY_RANK = { smart_money: 4, launchpad: 3, kol: 2, sniper: 1 };

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

function emptyRow(addr, chain) {
	return {
		address: addr,
		chain,
		categories: new Set(),
		name: '',
		twitter_username: '',
		avatar: '',
		realized_profit_30d_usd: 0,
		pnl_30d: null,
		pnl_7d: null,
		win_rate_30d: null,
		txs_30d: null,
		buy_30d: null,
		sell_30d: null,
		follow_count: 0,
		avg_holding_period_30d: null,
		last_active: 0,
	};
}

// Keep the richer/fresher value for each identity + performance field as a wallet
// is seen across buckets. Profit/follow take the max; identity prefers non-empty.
function fold(row, e) {
	const profit = num(e.realized_profit_30d) || 0;
	if (profit > row.realized_profit_30d_usd) {
		row.realized_profit_30d_usd = profit;
		row.pnl_30d = num(e.pnl_30d);
		row.win_rate_30d = num(e.winrate_30d);
		row.txs_30d = num(e.txs_30d);
		row.buy_30d = num(e.buy_30d);
		row.sell_30d = num(e.sell_30d);
		row.avg_holding_period_30d = num(e.avg_holding_period_30d);
	}
	if (row.pnl_7d == null) row.pnl_7d = num(e.pnl_7d);
	row.follow_count = Math.max(row.follow_count, num(e.follow_count) || 0);
	row.last_active = Math.max(row.last_active, num(e.last_active) || 0);
	const name = e.twitter_name || e.name || e.nickname || '';
	if (name && !row.name) row.name = name;
	if (e.twitter_username && !row.twitter_username) row.twitter_username = e.twitter_username;
	if (e.avatar && !row.avatar) row.avatar = e.avatar;
}

function distill(file, chain, into) {
	if (!fs.existsSync(file)) {
		console.warn(`  skip ${chain}: ${file} not found`);
		return;
	}
	const data = JSON.parse(fs.readFileSync(file, 'utf8'));
	const ingest = (entries, bucket) => {
		const category = BUCKET_CATEGORY[bucket];
		if (!category) return;
		for (const e of entries) {
			const addr = e.wallet_address || e.address;
			if (!addr || addr.length < 30) continue;
			const key = `${chain}:${addr}`;
			const row = into.get(key) || emptyRow(addr, chain);
			row.categories.add(category);
			fold(row, e);
			into.set(key, row);
		}
	};

	const smartMoney = data?.smartMoney?.wallets || {};
	for (const [bucket, entries] of Object.entries(smartMoney)) {
		if (Array.isArray(entries)) ingest(entries, bucket);
	}
	// kol.wallets is an index-keyed map in these scrapes; values are entries.
	const kol = data?.kol?.wallets || {};
	ingest(Array.isArray(kol) ? kol : Object.values(kol), 'kol');
}

// Composite rank: realized USD profit is the spine (log-scaled so a handful of
// outliers don't bury everyone), nudged by conviction (pnl multiple), accuracy
// (win rate) and reach (follower count). Used as the default ordering.
function score(r) {
	const profit = Math.log10(Math.max(r.realized_profit_30d_usd, 1)) * 18;
	const conviction = r.pnl_30d != null ? Math.min(Math.max(r.pnl_30d, 0), 50) * 1.2 : 0;
	const accuracy = r.win_rate_30d != null ? r.win_rate_30d * 30 : 0;
	const reach = Math.log10(Math.max(r.follow_count, 1)) * 4;
	return Math.round(profit + conviction + accuracy + reach);
}

const merged = new Map();
for (const { file, chain } of SOURCES) distill(file, chain, merged);

const wallets = [...merged.values()]
	.map((r) => {
		const categories = [...r.categories].sort((a, b) => CATEGORY_RANK[b] - CATEGORY_RANK[a]);
		return {
			address: r.address,
			chain: r.chain,
			category: categories[0],
			categories,
			name: r.name || null,
			twitter_username: r.twitter_username || null,
			avatar: r.avatar || null,
			realized_profit_30d_usd: Math.round(r.realized_profit_30d_usd),
			pnl_30d: r.pnl_30d,
			pnl_7d: r.pnl_7d,
			win_rate_30d: r.win_rate_30d,
			txs_30d: r.txs_30d,
			buy_30d: r.buy_30d,
			sell_30d: r.sell_30d,
			follow_count: r.follow_count || null,
			avg_holding_period_30d: r.avg_holding_period_30d,
			last_active: r.last_active || null,
			score: score(r),
		};
	})
	.sort((a, b) => b.score - a.score);

const counts = { byChain: {}, byCategory: {} };
for (const w of wallets) {
	counts.byChain[w.chain] = (counts.byChain[w.chain] || 0) + 1;
	counts.byCategory[w.category] = (counts.byCategory[w.category] || 0) + 1;
}

console.log('── Smart Money directory ───────────────────────────────');
console.log(`  Total wallets : ${wallets.length}`);
console.log(`  By chain      : ${JSON.stringify(counts.byChain)}`);
console.log(`  By category   : ${JSON.stringify(counts.byCategory)}`);
console.log(`  With twitter  : ${wallets.filter((w) => w.twitter_username).length}`);

if (DRY) {
	console.log('[dry-run] not writing');
	process.exit(0);
}

const output = {
	meta: {
		source: 'gmgn.ai smart-money taxonomy (nirholas/scrape-smart-wallets)',
		generated_at: new Date().toISOString(),
		total: wallets.length,
		counts,
	},
	wallets,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(output));
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
