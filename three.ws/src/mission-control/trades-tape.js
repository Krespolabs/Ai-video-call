/**
 * Mission Control — live trades tape.
 *
 * A scrolling table of real on-chain buys/sells for the focused coin, sourced
 * from two real data paths (never fabricated):
 *
 *   • PumpPortal SSE  — /api/pump/trades-stream?mint, same firehose the chart
 *     uses. Delivers tick-by-tick trades for pump.fun bonding-curve + pump-AMM.
 *   • GeckoTerminal   — /api/pump/dex-trades?mint, polled every ~8s. Used for
 *     graduated coins (Raydium/Orca pools) that the PumpPortal stream misses.
 *
 * The tape dedupes by tx signature so polling and streaming don't double-post
 * the same trade. When both sources are silent (brand-new launch, no trades
 * yet) the tape shows an honest empty state, not a skeleton that never fills.
 */

import { createSseClient } from './realtime.js';
import {
	escapeHtml,
	shortAddress,
	formatCompactUsd,
	formatCompact,
	explorerTxUrl,
	explorerAddressUrl,
} from './format.js';

const MAX_TRADES = 60;
const DEX_POLL_MS = 8_000;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {string} opts.mint
 * @param {string} [opts.network]
 * @returns {{ destroy(): void }}
 */
export function mountTradesTape({ host, mint, network = 'mainnet' }) {
	let destroyed = false;
	let sse = null;
	let pollTimer = null;
	const seen = new Set();   // tx signatures already in the tape
	const trades = [];        // newest first
	let liveReceived = false; // did the SSE ever deliver a trade?
	let rafToken = 0;

	host.innerHTML = `
		<div class="mc-tape-wrap">
			<div class="mc-tape-head">
				<span>Age</span><span>Type</span><span>MC</span>
				<span class="mc-tape-col-amt">Tokens</span>
				<span>USD</span><span>Wallet</span>
			</div>
			<div class="mc-tape-body" data-host="body">
				<div class="mc-tape-empty" data-host="empty">Waiting for trades…</div>
			</div>
		</div>`;

	const bodyEl = host.querySelector('[data-host="body"]');
	const emptyEl = host.querySelector('[data-host="empty"]');

	function scheduleRender() {
		if (rafToken) return;
		rafToken = requestAnimationFrame(() => { rafToken = 0; render(); });
	}

	function formatAge(ts) {
		if (!ts) return '—';
		const secs = Math.floor(Date.now() / 1000) - ts;
		if (secs < 0) return 'now';
		if (secs < 60) return `${secs}s`;
		const m = Math.floor(secs / 60);
		if (m < 60) return `${m}m`;
		return `${Math.floor(m / 60)}h`;
	}

	function render() {
		if (trades.length === 0) {
			emptyEl.hidden = false;
			// Clear any old rows (keep the empty sentinel)
			for (const el of [...bodyEl.children]) {
				if (el !== emptyEl) el.remove();
			}
			return;
		}
		emptyEl.hidden = true;

		// Efficient DOM update: reconcile by signature
		const existingById = new Map();
		for (const el of bodyEl.querySelectorAll('[data-sig]')) {
			existingById.set(el.dataset.sig, el);
		}

		const frag = document.createDocumentFragment();
		for (const t of trades) {
			if (existingById.has(t.sig)) {
				// Update age only (cheap)
				const el = existingById.get(t.sig);
				const ageEl = el.querySelector('[data-age]');
				if (ageEl) ageEl.textContent = formatAge(t.ts);
				existingById.delete(t.sig);
				frag.appendChild(el);
			} else {
				frag.appendChild(buildRow(t));
			}
		}
		// Remove rows no longer in the buffer
		for (const el of existingById.values()) el.remove();

		bodyEl.appendChild(frag);
	}

	function buildRow(t) {
		const isBuy = t.is_buy;
		const cls = isBuy ? 'mc-tape-row mc-tape-row--buy' : 'mc-tape-row mc-tape-row--sell';
		const label = isBuy ? 'Buy' : 'Sell';
		const mc = formatCompactUsd(t.market_cap_usd);
		const amt = t.token_amount != null ? formatCompact(t.token_amount) : '—';
		const usd = t.usd != null ? formatCompactUsd(t.usd) : '—';
		const txHref = t.sig ? explorerTxUrl(t.sig, network) : null;
		const walletHref = t.trader ? explorerAddressUrl(t.trader, network) : null;
		const walletLabel = t.trader ? shortAddress(t.trader, 4, 4) : '—';

		const el = document.createElement('div');
		el.className = cls;
		el.dataset.sig = t.sig || '';
		el.innerHTML = `
			<span data-age>${formatAge(t.ts)}</span>
			<span class="mc-tape-type">${txHref ? `<a href="${escapeHtml(txHref)}" target="_blank" rel="noopener">${label}</a>` : label}</span>
			<span class="mc-num">${mc}</span>
			<span class="mc-num mc-tape-col-amt">${amt}</span>
			<span class="mc-num">${usd}</span>
			<span>${walletHref ? `<a class="mc-mono" href="${escapeHtml(walletHref)}" target="_blank" rel="noopener">${escapeHtml(walletLabel)}</a>` : `<span class="mc-mono">${escapeHtml(walletLabel)}</span>`}</span>`;
		return el;
	}

	function ingestSseTrade(d) {
		if (!d || d.mint !== mint) return;
		liveReceived = true;
		addTrade({
			sig: d.tx_signature || d.signature || `live-${Date.now()}-${Math.random()}`,
			ts: Number(d.timestamp) || Math.floor(Date.now() / 1000),
			is_buy: !!d.is_buy,
			token_amount: d.token_amount != null ? Number(d.token_amount) : null,
			sol_amount: d.sol_amount != null ? Number(d.sol_amount) : null,
			usd: d.sol_value_usd != null ? Number(d.sol_value_usd) : null,
			market_cap_usd: d.market_cap_usd != null ? Number(d.market_cap_usd) : null,
			trader: d.trader || null,
		});
	}

	function ingestDexTrades(arr) {
		if (!Array.isArray(arr)) return;
		for (const t of arr) {
			addTrade({
				sig: t.signature || t.tx_hash || `dex-${Date.now()}-${Math.random()}`,
				ts: t.timestamp != null ? Number(t.timestamp) : Math.floor(Date.now() / 1000),
				is_buy: !!t.is_buy,
				token_amount: t.token_amount != null ? Number(t.token_amount) : null,
				sol_amount: t.sol_amount != null ? Number(t.sol_amount) : null,
				usd: t.usd != null ? Number(t.usd) : null,
				market_cap_usd: null,
				trader: t.trader || null,
			});
		}
	}

	function addTrade(t) {
		if (!t.sig || seen.has(t.sig)) return;
		seen.add(t.sig);
		trades.unshift(t); // newest first
		if (trades.length > MAX_TRADES) {
			const dropped = trades.splice(MAX_TRADES);
			dropped.forEach((d) => seen.delete(d.sig));
		}
		scheduleRender();
	}

	// ── age refresh timer (update "3s" → "4s" every second) ────────────────────
	const ageTimer = setInterval(() => {
		if (destroyed || trades.length === 0) return;
		for (const el of bodyEl.querySelectorAll('[data-age]')) {
			const row = el.closest('[data-sig]');
			if (!row) continue;
			const t = trades.find((x) => x.sig === row.dataset.sig);
			if (t) el.textContent = formatAge(t.ts);
		}
	}, 1_000);

	// ── SSE (pump.fun bonding-curve + pump-AMM trades) ───────────────────────
	sse = createSseClient({
		url: `/api/pump/trades-stream?mint=${encodeURIComponent(mint)}`,
		events: {
			trade: (d) => ingestSseTrade(d),
			open: () => {},
			close: () => {},
			ping: () => {},
		},
		onState: () => {},
	});
	sse.start();

	// ── dex-trades polling (graduated coins on Raydium / Orca) ──────────────
	async function pollDexTrades() {
		if (destroyed) return;
		try {
			const r = await fetch(`/api/pump/dex-trades?mint=${encodeURIComponent(mint)}&limit=30`, {
				headers: { accept: 'application/json' },
			});
			if (r.ok) {
				const data = await r.json();
				ingestDexTrades(data?.trades);
			}
		} catch { /* network blip */ }
	}

	pollDexTrades();
	pollTimer = setInterval(pollDexTrades, DEX_POLL_MS);

	return {
		destroy() {
			destroyed = true;
			if (rafToken) cancelAnimationFrame(rafToken);
			clearInterval(ageTimer);
			clearInterval(pollTimer);
			try { sse?.stop(); } catch {}
			host.innerHTML = '';
		},
	};
}
