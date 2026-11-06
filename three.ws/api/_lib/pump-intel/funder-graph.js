// Funding-graph tracer for pump.fun wallet clustering.
//
// "Are these wallets connected?" is the literal bubblemaps question. The answer
// is: did they receive SOL from a common source shortly before buying?
//
// Method: for each buyer wallet, fetch its last N Solana system transfers
// (SOL in) via Helius enhanced-txn API and return the sending wallet (the
// "funder"). Wallets sharing a funder are a cluster — coordinated, not organic.
//
// This is the cheapest possible funding graph: one Helius call per wallet, no
// graph DB, no indexer. It correctly identifies the classic bundle attack
// (coordinator funds N fresh wallets → all buy within a slot) and also catches
// insider relationships (dev's own wallet funded the "organic" buyers).
//
// Rate limiting: Helius free tier is 10 req/s sustained. We cap concurrent
// calls and cache results aggressively — a wallet's funder doesn't change.

const HELIUS_API = 'https://api.helius.xyz/v0';
const FUNDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — funders don't change
const MAX_CONCURRENT = 6;
const PER_WALLET_TIMEOUT_MS = 4_000;
const MAX_TXS_TO_SCAN = 10; // earliest relevant txs; funder is usually in first few

// In-process cache: wallet -> { funder, resolvedAt }
const _cache = new Map();

function apiKey() {
	return process.env.HELIUS_API_KEY || '';
}

function cacheGet(wallet) {
	const hit = _cache.get(wallet);
	if (!hit) return undefined;
	if (Date.now() - hit.resolvedAt > FUNDER_CACHE_TTL_MS) { _cache.delete(wallet); return undefined; }
	return hit.funder; // may be null (no funder found) — still cached
}

function cacheSet(wallet, funder) {
	_cache.set(wallet, { funder, resolvedAt: Date.now() });
	// Evict oldest 25% when over 10k
	if (_cache.size > 10_000) {
		const drop = 2_500;
		const it = _cache.keys();
		for (let i = 0; i < drop; i++) _cache.delete(it.next().value);
	}
}

/**
 * Resolve the primary SOL funder for a single wallet.
 * Returns the sender address (string) or null if not found / Helius unavailable.
 */
async function resolveFunder(wallet) {
	const cached = cacheGet(wallet);
	if (cached !== undefined) return cached;

	const k = apiKey();
	if (!k) { cacheSet(wallet, null); return null; }

	try {
		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), PER_WALLET_TIMEOUT_MS);

		const url = `${HELIUS_API}/addresses/${encodeURIComponent(wallet)}/transactions` +
			`?api-key=${k}&limit=${MAX_TXS_TO_SCAN}&type=TRANSFER`;
		const r = await fetch(url, { signal: ctrl.signal });
		clearTimeout(tid);

		if (!r.ok) { cacheSet(wallet, null); return null; }
		const txs = await r.json();
		if (!Array.isArray(txs) || !txs.length) { cacheSet(wallet, null); return null; }

		// Walk transactions oldest-first. We want the FIRST significant SOL-in
		// transfer to this wallet — that's the funder that armed it for the launch.
		// Helius returns newest-first, so we reverse.
		const reversed = [...txs].reverse();

		let funder = null;
		for (const tx of reversed) {
			// Helius enhanced transactions expose nativeTransfers as [{fromUserAccount,
			// toUserAccount, amount}] and accountData as balance changes.
			const transfers = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [];
			for (const t of transfers) {
				if (
					t.toUserAccount === wallet &&
					typeof t.amount === 'number' &&
					t.amount >= 5_000_000 && // ≥0.005 SOL — ignore dust
					t.fromUserAccount &&
					t.fromUserAccount !== wallet
				) {
					funder = t.fromUserAccount;
					break;
				}
			}
			if (funder) break;
		}

		cacheSet(wallet, funder);
		return funder;
	} catch {
		cacheSet(wallet, null);
		return null;
	}
}

/**
 * Resolve funders for a set of wallets concurrently (capped at MAX_CONCURRENT).
 * Returns Map<wallet, funder|null>.
 *
 * @param {string[]} wallets
 * @returns {Promise<Map<string, string|null>>}
 */
export async function resolveWalletFunders(wallets) {
	const unique = [...new Set(wallets.filter(Boolean))];
	const result = new Map();

	// Serve cache hits immediately — no I/O needed
	const uncached = [];
	for (const w of unique) {
		const hit = cacheGet(w);
		if (hit !== undefined) {
			result.set(w, hit);
		} else {
			uncached.push(w);
		}
	}

	if (!uncached.length || !apiKey()) {
		for (const w of uncached) result.set(w, null);
		return result;
	}

	// Concurrency-limited resolution
	const queue = [...uncached];
	let active = 0;
	let idx = 0;

	await new Promise((resolve) => {
		function next() {
			if (idx >= queue.length && active === 0) { resolve(); return; }
			while (active < MAX_CONCURRENT && idx < queue.length) {
				const wallet = queue[idx++];
				active++;
				resolveFunder(wallet)
					.then((funder) => { result.set(wallet, funder); })
					.catch(() => { result.set(wallet, null); })
					.finally(() => { active--; next(); });
			}
		}
		next();
	});

	return result;
}

/**
 * Build cluster map: group wallets by common funder.
 * Returns { clusters: Map<funder, string[]>, connectivity: number|null }
 *
 * connectivity: share of wallets with a known funder that share the biggest cluster.
 * null if fewer than 3 wallets have resolved funders.
 */
export function buildClusters(funderMap) {
	const byFunder = new Map(); // funder -> [wallets]
	let known = 0;

	for (const [wallet, funder] of funderMap) {
		if (!funder) continue;
		known++;
		if (!byFunder.has(funder)) byFunder.set(funder, []);
		byFunder.get(funder).push(wallet);
	}

	const clusters = new Map([...byFunder].filter(([, ws]) => ws.length >= 2));

	let connectivity = null;
	if (known >= 3) {
		const biggestCluster = clusters.size
			? Math.max(...[...clusters.values()].map((ws) => ws.length))
			: 0;
		connectivity = Math.round((biggestCluster / known) * 10000) / 10000;
	}

	return { clusters, connectivity };
}

/** Export cache size for monitoring. */
export function funderCacheSize() { return _cache.size; }
