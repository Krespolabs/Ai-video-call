// pnl-fetch.js — the data layer for the live Portfolio / PnL HUD.
//
// Two real backends, two transports, one normalized `PnlSnapshot` out:
//   • fetchBatchBalances(ids)  → ONE POST /api/agents/balances for many wallets
//     (the wall hydrates every visible card's badge in a single round-trip).
//   • fetchAgentBalance(id)    → the same endpoint for a single agent (the HUD
//     poll), returning that agent's snapshot or an un-priced one.
//   • subscribePortfolio(id, …) → owner-only SSE to /api/agents/:id/portfolio/
//     stream, pushing fresher net-worth + per-holding cost basis between polls.
//     Reconnects with backoff, mirroring agent-screen-client.js.
//
// Errors surface to the caller (handled at the UI boundary) — a failed read
// returns an un-priced snapshot, never a fake zero, and never a synthesized
// curve. No DOM here; all rendering lives in the HUD / badge.

import { toPnlSnapshot, emptyPnlSnapshot } from './pnl-snapshot.js';

// Mirror the server cap (api/agents/balances.js MAX_IDS) so we chunk correctly.
const MAX_BATCH = 60;

// Lazily reuse the app's CSRF-aware fetch; fall back to a credentialed fetch so
// the module also works on pages that don't ship src/api.js.
let _apiFetchPromise = null;
function getApiFetch() {
	if (!_apiFetchPromise) {
		_apiFetchPromise = import('../api.js')
			.then((m) => m.apiFetch)
			.catch(() => (path, opts) => fetch(path, { credentials: 'include', ...opts }));
	}
	return _apiFetchPromise;
}

/**
 * Value a batch of agent wallets in one request and return normalized snapshots
 * keyed by agent id. Ids missing from the response (or that failed to price)
 * resolve to an un-priced snapshot so callers can render every id uniformly.
 *
 * @param {string[]} agentIds
 * @param {{ network?: 'mainnet'|'devnet' }} [opts]
 * @returns {Promise<Map<string, import('./pnl-snapshot.js').PnlSnapshot>>}
 */
export async function fetchBatchBalances(agentIds, { network = 'mainnet' } = {}) {
	const ids = [...new Set((agentIds || []).filter((x) => typeof x === 'string' && x))];
	const out = new Map();
	if (ids.length === 0) return out;

	const apiFetch = await getApiFetch();
	for (let i = 0; i < ids.length; i += MAX_BATCH) {
		const chunk = ids.slice(i, i + MAX_BATCH);
		let data = null;
		try {
			const res = await apiFetch('/api/agents/balances', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: chunk, network }),
				allowAnonymous: true,
			});
			if (res.ok) ({ data } = await res.json());
		} catch {
			data = null; // surface as un-priced below; caller decides how to show it
		}
		for (const id of chunk) {
			out.set(id, data && data[id] ? toPnlSnapshot(data[id]) : emptyPnlSnapshot());
		}
	}
	return out;
}

/**
 * Single-agent balance read (the HUD's poll). Returns a normalized snapshot,
 * un-priced on any failure.
 *
 * @param {string} agentId
 * @param {{ network?: 'mainnet'|'devnet' }} [opts]
 * @returns {Promise<import('./pnl-snapshot.js').PnlSnapshot>}
 */
export async function fetchAgentBalance(agentId, opts = {}) {
	if (!agentId) return emptyPnlSnapshot();
	const map = await fetchBatchBalances([agentId], opts);
	return map.get(agentId) || emptyPnlSnapshot();
}

/**
 * Subscribe to the owner-only portfolio SSE. Pushes a normalized `PnlSnapshot`
 * on every server `snapshot` event, with reconnect-on-drop backoff. Returns a
 * disposer that closes the stream and stops retrying. `onStatus` (optional) is
 * notified with 'open' | 'reconnecting' | 'closed' for the HUD's live tick.
 *
 * The stream is owner-gated server-side; a non-owner / signed-out caller gets a
 * 401 that surfaces as an error event → 'reconnecting' (and the HUD simply keeps
 * polling balances). No fabricated data is ever emitted.
 *
 * @param {string} agentId
 * @param {(snap: import('./pnl-snapshot.js').PnlSnapshot) => void} onSnapshot
 * @param {{ network?: string, onStatus?: (s:string)=>void, onError?: (e:Error)=>void }} [opts]
 * @returns {() => void} dispose
 */
export function subscribePortfolio(agentId, onSnapshot, opts = {}) {
	const { network = 'mainnet', onStatus, onError } = opts;
	const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 20000];
	const url = `/api/agents/${encodeURIComponent(agentId)}/portfolio/stream${network === 'devnet' ? '?network=devnet' : ''}`;

	let es = null;
	let reconnectTimer = null;
	let attempt = 0;
	let destroyed = false;

	function connect() {
		if (destroyed || es) return;
		try {
			es = new EventSource(url, { withCredentials: true });
		} catch (e) {
			onError?.(e instanceof Error ? e : new Error('sse_unavailable'));
			return;
		}

		es.addEventListener('open', () => { attempt = 0; onStatus?.('open'); });

		es.addEventListener('snapshot', (e) => {
			try {
				const raw = JSON.parse(e.data);
				onSnapshot?.(toPnlSnapshot(raw));
			} catch { /* malformed frame — ignore, keep stream */ }
		});

		es.addEventListener('bye', () => { destroyed ? null : scheduleReconnect(); });

		es.onerror = () => {
			onStatus?.('reconnecting');
			onError?.(new Error('portfolio_stream_disconnected'));
			scheduleReconnect();
		};
	}

	function scheduleReconnect() {
		try { es?.close(); } catch { /* */ }
		es = null;
		if (destroyed) return;
		const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
		attempt++;
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connect, delay);
	}

	connect();

	return function dispose() {
		destroyed = true;
		onStatus?.('closed');
		clearTimeout(reconnectTimer);
		try { es?.close(); } catch { /* */ }
		es = null;
	};
}
