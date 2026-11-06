// Hedged Solana transaction broadcast.
//
// A signed Solana transaction has a fixed signature, so re-broadcasting the SAME
// signed bytes to many RPCs only ever lands ONCE (the cluster dedupes by
// signature). That makes it safe — and, for the free/public RPC tier where
// `sendTransaction` is the flaky, rate-limited, sometimes-throttled method — much
// faster and more reliable to fire the send at EVERY healthy endpoint at once and
// take the first that accepts it, instead of trying them one at a time.
//
// This complements the sequential `RpcFallback` (rpc-fallback.js): use the
// fallback for reads (quote, blockhash, confirm), use this to get the buy/sell tx
// onto the chain with the best land-rate the free tier can give.
//
//   import { hedgedBroadcast } from './hedged-send.js';
//   const { signature, landed } = await hedgedBroadcast(rawTxBase64, endpoints);
//
// Pure over an injectable `fetchImpl` so it unit-tests without a network.

/**
 * @param {string} rawTxBase64  the fully-signed transaction, base64-encoded.
 * @param {string[]} endpoints  RPC URLs to race the send across.
 * @param {object} [opts]
 * @param {boolean} [opts.skipPreflight=true]  skip node-side simulation (we pre-simulate ourselves).
 * @param {number} [opts.perEndpointTimeoutMs=8000]  abort a single endpoint after this.
 * @param {typeof fetch} [opts.fetchImpl=fetch]  injectable for tests.
 * @returns {Promise<{ signature: string, endpoint: string, accepted: number, errors: string[] }>}
 */
export async function hedgedBroadcast(rawTxBase64, endpoints, {
	skipPreflight = true,
	perEndpointTimeoutMs = 8000,
	fetchImpl = fetch,
} = {}) {
	const urls = [...new Set((endpoints || []).filter(Boolean))];
	if (!rawTxBase64 || typeof rawTxBase64 !== 'string') throw new Error('hedgedBroadcast: rawTxBase64 required');
	if (urls.length === 0) throw new Error('hedgedBroadcast: no endpoints');

	const body = JSON.stringify({
		jsonrpc: '2.0', id: 1, method: 'sendTransaction',
		params: [rawTxBase64, { encoding: 'base64', skipPreflight, maxRetries: 0 }],
	});

	const errors = [];
	let accepted = 0;
	const attempt = (url) => {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), perEndpointTimeoutMs);
		return Promise.resolve()
			.then(() => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ac.signal }))
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const j = await res.json();
				if (j && typeof j.result === 'string') { accepted += 1; return { signature: j.result, endpoint: url }; }
				throw new Error(j?.error?.message ? String(j.error.message).slice(0, 80) : 'no result');
			})
			.catch((e) => { errors.push(`${maskHost(url)}: ${e?.message || e}`); throw e; })
			.finally(() => clearTimeout(timer));
	};

	// Promise.any resolves with the FIRST endpoint that accepts the tx; rejects only
	// if every endpoint fails. All accepters return the same signature (signed bytes
	// are identical), so whichever wins the race is authoritative.
	try {
		const win = await Promise.any(urls.map(attempt));
		return { signature: win.signature, endpoint: win.endpoint, accepted, errors };
	} catch {
		throw new Error(`hedgedBroadcast: all ${urls.length} endpoints rejected the send — ${errors.join(' | ')}`);
	}
}

function maskHost(url) {
	try { return new URL(url).host; } catch { return String(url).slice(0, 24); }
}
