// Reputation panel for the agent screen — the trust story beside the avatar.
//
// Two real, verifiable layers, stacked:
//   1. The full wallet-trust breakdown (score, tier, pillars, on-chain evidence)
//      via the shared reputationPanelEl — the same non-gameable score the badge
//      shows everywhere, computed server-side from real ledger + chain facts.
//   2. The a2a-hire RECEIPTS that built it: every completed hire this agent was
//      paid for, each a real USDC settlement with an explorer link and, once the
//      hirer rates it, the 1–5★ that moves the score. A tiny sparkline draws the
//      agent's real rating history over those receipts.
//
// Nothing is computed or faked here. Receipts come from
// GET /api/agents/economy?view=hires&role=provider; an agent with no hires yet
// renders an honest empty state, never a fabricated history.

import { apiFetch } from './api.js';
import { reputationPanelEl, ensureReputationStyles } from './shared/agent-reputation.js';

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtUsd(n) {
	const v = Number(n) || 0;
	return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`;
}

function fmtTime(iso) {
	if (!iso) return '';
	try {
		const diff = (Date.now() - new Date(iso).getTime()) / 1000;
		if (diff < 90) return 'just now';
		if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
		if (diff < 604800) return `${Math.round(diff / 86400)}d ago`;
		return new Date(iso).toLocaleDateString();
	} catch {
		return '';
	}
}

// USDC settlements and the agent-invocation receipt both land on Solana mainnet.
function explorerUrl(sig) {
	return sig ? `https://solscan.io/tx/${encodeURIComponent(sig)}` : null;
}

const STATUS_TONE = { completed: 'ok', pending: 'warn', refunded: 'dim', failed: 'bad', disputed: 'bad' };

function starsHTML(rating) {
	if (rating == null) return '<span class="ascrep-rc-unrated">unrated</span>';
	const r = Math.max(0, Math.min(5, Math.round(rating)));
	return `<span class="ascrep-rc-stars" title="${r}/5">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</span>`;
}

// A real rating history sparkline from the rated receipts (chronological).
function sparklineHTML(hires) {
	const rated = hires
		.filter((h) => h.rating != null)
		.slice()
		.reverse(); // listHiresForAgent is newest-first → oldest-first for the timeline
	if (rated.length < 2) return '';
	const W = 240;
	const H = 34;
	const pad = 3;
	const pts = rated.map((h, i) => {
		const x = pad + (i / (rated.length - 1)) * (W - pad * 2);
		const y = pad + (1 - (Math.max(1, Math.min(5, h.rating)) - 1) / 4) * (H - pad * 2);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const avg = (rated.reduce((s, h) => s + h.rating, 0) / rated.length).toFixed(1);
	const dots = pts
		.map((p) => {
			const [x, y] = p.split(',');
			return `<circle cx="${x}" cy="${y}" r="1.7" fill="var(--screen-accent,#9a7bff)"/>`;
		})
		.join('');
	return (
		`<div class="ascrep-spark"><div class="ascrep-spark-head"><span>Rating history</span><span class="ascrep-spark-avg">${avg}★ avg · ${rated.length} rated</span></div>` +
		`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Rating history sparkline, average ${avg} of 5">` +
		`<polyline fill="none" stroke="var(--screen-accent,#9a7bff)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/>${dots}</svg></div>`
	);
}

function receiptHTML(h) {
	const tone = STATUS_TONE[h.status] || 'dim';
	const links = [
		h.payment_signature ? `<a class="ascrep-rc-link" href="${esc(explorerUrl(h.payment_signature))}" target="_blank" rel="noopener noreferrer">payment ↗</a>` : '',
		h.invocation_signature ? `<a class="ascrep-rc-link" href="${esc(explorerUrl(h.invocation_signature))}" target="_blank" rel="noopener noreferrer">receipt ↗</a>` : '',
	]
		.filter(Boolean)
		.join('');
	return (
		`<li class="ascrep-rc">` +
		`<div class="ascrep-rc-top">` +
		`<span class="ascrep-rc-skill" title="${esc(h.skill_name || h.service_slug || 'hire')}">${esc(h.skill_name || h.service_slug || 'Hire')}</span>` +
		`<span class="ascrep-rc-amt">${esc(fmtUsd(h.usd))}</span>` +
		`</div>` +
		`<div class="ascrep-rc-mid">${starsHTML(h.rating)}<span class="ascrep-rc-status ascrep-rc-status--${tone}">${esc(h.status)}</span></div>` +
		`<div class="ascrep-rc-bot">` +
		`<span class="ascrep-rc-cp" title="Hired by ${esc(h.counterparty?.name || 'agent')}">↤ ${esc(h.counterparty?.name || 'Agent')}</span>` +
		`<span class="ascrep-rc-time">${esc(fmtTime(h.completed_at || h.created_at))}</span>` +
		(links ? `<span class="ascrep-rc-links">${links}</span>` : '') +
		`</div></li>`
	);
}

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const st = document.createElement('style');
	st.id = 'ascrep-style';
	st.textContent = `
.ascrep-body{display:flex;flex-direction:column;gap:0.7rem;padding:0.2rem 0.1rem}
.ascrep-receipts-head{display:flex;align-items:baseline;justify-content:space-between;gap:0.5rem;margin-top:0.2rem}
.ascrep-receipts-title{font-size:0.64rem;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.42);font-weight:650}
.ascrep-receipts-sub{font-size:0.66rem;color:rgba(255,255,255,0.32)}
.ascrep-spark{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:9px;padding:0.5rem 0.6rem}
.ascrep-spark-head{display:flex;justify-content:space-between;font-size:0.64rem;color:rgba(255,255,255,0.42);margin-bottom:0.25rem}
.ascrep-spark-avg{color:var(--screen-accent,#9a7bff);font-weight:650}
.ascrep-spark svg{width:100%;height:34px;display:block}
.ascrep-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.4rem;max-height:280px;overflow-y:auto}
.ascrep-rc{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:9px;padding:0.45rem 0.6rem;transition:border-color .14s,background .14s}
.ascrep-rc:hover{border-color:rgba(255,255,255,0.18);background:rgba(255,255,255,0.05)}
.ascrep-rc-top{display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem}
.ascrep-rc-skill{font-size:0.8rem;font-weight:640;color:#f4f4f5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ascrep-rc-amt{font-size:0.78rem;font-weight:680;color:#86efac;font-variant-numeric:tabular-nums;white-space:nowrap}
.ascrep-rc-mid{display:flex;align-items:center;gap:0.5rem;margin:0.25rem 0}
.ascrep-rc-stars{color:#fbbf24;font-size:0.74rem;letter-spacing:0.04em}
.ascrep-rc-unrated{font-size:0.66rem;color:rgba(255,255,255,0.3)}
.ascrep-rc-status{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.04em;font-weight:650;padding:1px 6px;border-radius:999px}
.ascrep-rc-status--ok{color:#86efac;background:rgba(134,239,172,0.12)}
.ascrep-rc-status--warn{color:#fcd34d;background:rgba(252,211,77,0.12)}
.ascrep-rc-status--bad{color:#fda4af;background:rgba(253,164,175,0.12)}
.ascrep-rc-status--dim{color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.06)}
.ascrep-rc-bot{display:flex;align-items:center;gap:0.5rem;font-size:0.66rem;color:rgba(255,255,255,0.42);flex-wrap:wrap}
.ascrep-rc-cp{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:9rem}
.ascrep-rc-time{margin-left:auto}
.ascrep-rc-links{display:flex;gap:0.4rem;flex-basis:100%}
.ascrep-rc-link{color:var(--screen-accent,#9a7bff);text-decoration:none;font-weight:600}
.ascrep-rc-link:hover{text-decoration:underline}
.ascrep-empty,.ascrep-error{text-align:center;padding:0.9rem 0.6rem;font-size:0.74rem;color:rgba(255,255,255,0.5);line-height:1.45}
.ascrep-empty a{color:var(--screen-accent,#9a7bff);text-decoration:none;font-weight:600}
.ascrep-empty a:hover{text-decoration:underline}
.ascrep-retry{margin-top:0.5rem;font:inherit;font-size:0.74rem;font-weight:600;color:#fff;background:rgba(154,123,255,0.18);border:1px solid rgba(154,123,255,0.45);border-radius:8px;padding:0.35rem 0.8rem;cursor:pointer}
.ascrep-retry:hover{background:rgba(154,123,255,0.3)}
.ascrep-sk{height:48px;border-radius:9px;background:linear-gradient(90deg,rgba(255,255,255,0.03) 25%,rgba(255,255,255,0.07) 37%,rgba(255,255,255,0.03) 63%);background-size:400% 100%;animation:ascrep-shimmer 1.4s ease infinite}
@keyframes ascrep-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
@media (prefers-reduced-motion:reduce){.ascrep-sk{animation:none}}`;
	document.head.appendChild(st);
}

/**
 * Mount the reputation panel into a panel body. Self-loading and self-healing:
 * the trust breakdown and the receipts each render their own loading → populated
 * → error states, and a new completed hire pushed onto the log refreshes the
 * receipts.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {HTMLElement} opts.bodyEl
 * @returns {{ refresh():void, observeHire():void, destroy():void }}
 */
export function createReputationPanel({ agentId, bodyEl, onNewReceipt = null }) {
	ensureReputationStyles();
	ensureStyles();
	bodyEl.classList.add('ascrep-body');

	// Receipt ids seen so far, so a refresh can tell a genuinely NEW hire from the
	// ones already on screen and fire the live nudge only for real new activity.
	const _seen = new Set();
	let _initialized = false;

	// Layer 1: the shared trust breakdown (loads its own real data).
	const breakdown = reputationPanelEl(agentId, { unlocks: false });
	bodyEl.appendChild(breakdown);

	// Layer 2: the receipts that earned the score.
	const receipts = document.createElement('div');
	receipts.className = 'ascrep-receipts';
	bodyEl.appendChild(receipts);

	let _loaded = false;
	let _loading = false;

	function skeleton() {
		receipts.innerHTML =
			`<div class="ascrep-receipts-head"><span class="ascrep-receipts-title">A2A-hire receipts</span></div>` +
			`<div class="ascrep-sk"></div><div class="ascrep-sk" style="margin-top:0.4rem"></div>`;
	}

	async function load() {
		if (_loading) return;
		_loading = true;
		if (!_loaded) skeleton();
		try {
			const res = await apiFetch(
				`/api/agents/economy?view=hires&role=provider&limit=40&agentId=${encodeURIComponent(agentId)}`,
				{ allowAnonymous: true },
			);
			if (!res.ok) throw new Error(`hires ${res.status}`);
			const { data } = await res.json();
			const hires = Array.isArray(data?.hires) ? data.hires : [];
			_loaded = true;
			detectNew(hires);
			render(hires);
		} catch {
			receipts.innerHTML =
				`<div class="ascrep-receipts-head"><span class="ascrep-receipts-title">A2A-hire receipts</span></div>` +
				`<div class="ascrep-error" role="alert">Couldn't load this agent's hire receipts just now.<br>` +
				`<button type="button" class="ascrep-retry">Try again</button></div>`;
			receipts.querySelector('.ascrep-retry')?.addEventListener('click', load);
		} finally {
			_loading = false;
		}
	}

	// Compare against the receipts we've already shown and, after the first load,
	// surface the newest genuinely-new hire as a live nudge. The very first load
	// only seeds the baseline so we never replay history as "new".
	function detectNew(hires) {
		const fresh = hires.filter((h) => h.id && !_seen.has(h.id));
		for (const h of hires) if (h.id) _seen.add(h.id);
		if (!_initialized) {
			_initialized = true;
			return;
		}
		if (!fresh.length || typeof onNewReceipt !== 'function') return;
		// hires are newest-first; the first fresh one is the most recent.
		onNewReceipt(fresh[0]);
	}

	function render(hires) {
		if (!hires.length) {
			receipts.innerHTML =
				`<div class="ascrep-receipts-head"><span class="ascrep-receipts-title">A2A-hire receipts</span></div>` +
				`<div class="ascrep-empty">No hires yet — this agent earns on-chain reputation by completing paid hires.<br>` +
				`<a href="/marketplace">Browse the marketplace →</a></div>`;
			return;
		}
		const total = hires.length;
		receipts.innerHTML =
			`<div class="ascrep-receipts-head"><span class="ascrep-receipts-title">A2A-hire receipts</span><span class="ascrep-receipts-sub">${total} hire${total === 1 ? '' : 's'} earned</span></div>` +
			sparklineHTML(hires) +
			`<ul class="ascrep-list">${hires.map(receiptHTML).join('')}</ul>`;
	}

	load();

	// Reputation moves slowly, and the receipts that earn it (this agent being
	// hired) arrive without a frame on this screen — so poll on a calm cadence to
	// pick them up. Pauses while the tab is hidden; detectNew() fires the nudge.
	const _poll = setInterval(() => {
		if (typeof document === 'undefined' || !document.hidden) load();
	}, 60_000);

	// Refresh the receipts when this agent settles a new hire (an a2a_hire frame
	// reaches the screen log). Debounced so a burst of frames is one refetch.
	let _hireT = null;
	function observeHire() {
		clearTimeout(_hireT);
		_hireT = setTimeout(load, 1500);
	}

	return {
		refresh: load,
		observeHire,
		destroy() {
			clearTimeout(_hireT);
			clearInterval(_poll);
		},
	};
}
