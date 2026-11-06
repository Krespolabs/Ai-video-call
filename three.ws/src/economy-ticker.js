// Live Economy ticker — the compact, embeddable face of the Galaxy Money-Cam.
//
// Drops onto the home page (and any surface that wants it) a real, always-on
// readout of value moving between three.ws agents: a headline "hottest earner
// right now" discovery hook, window totals, and a keyboard-navigable, screen-
// reader-readable list of the most recent on-chain flows — each one links
// through to the agent and to its real transaction on Solscan. The whole widget
// is a doorway into the full 3D map at /galaxy.
//
// Same real feed as the Money-Cam (GET /api/galaxy/flows). Every row is one
// explorer-verifiable transfer; nothing is fabricated. When the market is quiet
// the ticker says so honestly rather than inventing activity. Live updates come
// from a cheap delta poll (cursor handed back as ?since=), paused when the tab is
// hidden, with a clear "reconnecting" affordance on a dropped feed — mirroring
// the galaxy's own live pattern.

import {
	KIND_COLORS,
	KIND_LABEL,
	formatUsd,
	relTime,
	flowHeadline,
	rowHref,
	flowExplorer,
	summarizeFlows,
	hottestEarner,
} from './economy-ticker-core.js';

const REDUCED_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const POLL_MS = 12_000; // passive home widget — gentler than the galaxy's 6s
const MAX_ROWS = 8; // compact: newest N flows
const HISTORY_CAP = 60;

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}

function mount(root) {
	const state = {
		history: [], // ascending by ts
		seen: new Set(),
		headCursor: null,
		fails: 0,
		started: false,
		pollTimer: null,
		freshIds: new Set(), // ids to flash on next render (skipped under reduced-motion)
	};

	root.classList.add('eco-ticker');
	root.setAttribute('aria-label', 'Live economy — real value moving between agents');
	renderShell(root);

	const els = {
		status: root.querySelector('.eco-status'),
		hot: root.querySelector('.eco-hot'),
		stats: root.querySelector('.eco-stats'),
		list: root.querySelector('.eco-list'),
		note: root.querySelector('.eco-note'),
	};

	async function fetchFlows(params) {
		const qs = new URLSearchParams({ network: 'mainnet', type: 'all', limit: '24', ...params });
		const res = await fetch(`/api/galaxy/flows?${qs.toString()}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`flows ${res.status}`);
		const body = await res.json().catch(() => ({}));
		return body?.data || null;
	}

	function ingest(flowsNewestFirst) {
		const fresh = [];
		for (const f of flowsNewestFirst || []) {
			if (!f || state.seen.has(f.id)) continue;
			state.seen.add(f.id);
			fresh.push(f);
		}
		if (!fresh.length) return [];
		fresh.reverse(); // ascending
		state.history.push(...fresh);
		state.history.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
		if (state.history.length > HISTORY_CAP) {
			state.history.splice(0, state.history.length - HISTORY_CAP);
			state.seen = new Set(state.history.map((f) => f.id));
		}
		return fresh;
	}

	async function load() {
		setStatus('live', 'Live');
		try {
			const data = await fetchFlows();
			if (!data) throw new Error('no data');
			state.history = [];
			state.seen = new Set();
			ingest(data.flows || []);
			state.headCursor = data.head_cursor || null;
			state.fails = 0;
			setNote('');
			render();
			start();
		} catch {
			setStatus('stale', 'Offline');
			setNote('Couldn’t reach the live economy — retrying. No flows are invented to fill the gap.');
			scheduleRetry();
		}
	}

	async function poll() {
		if (document.hidden) return;
		if (!state.headCursor) return load();
		try {
			const data = await fetchFlows({ since: state.headCursor });
			if (!data) throw new Error('no data');
			const fresh = ingest(data.flows || []);
			if (data.head_cursor) state.headCursor = data.head_cursor;
			state.fails = 0;
			setStatus('live', 'Live');
			setNote('');
			if (fresh.length) {
				if (!REDUCED_MOTION) state.freshIds = new Set(fresh.map((f) => f.id));
				render();
			}
		} catch {
			state.fails++;
			if (state.fails >= 2) {
				setStatus('stale', 'Reconnecting…');
				setNote('Reconnecting to the live economy…');
			}
		}
	}

	function start() {
		stop();
		state.pollTimer = setInterval(poll, POLL_MS);
	}
	function stop() {
		if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
	}
	let retryTimer = null;
	function scheduleRetry() {
		clearTimeout(retryTimer);
		const delay = Math.min(30_000, 2_000 * 2 ** Math.min(4, state.fails));
		state.fails++;
		retryTimer = setTimeout(load, delay);
	}

	function setStatus(kind, label) {
		if (!els.status) return;
		els.status.className = `eco-status eco-status--${kind}`;
		els.status.innerHTML = `<span class="eco-dot" aria-hidden="true"></span>${esc(label)}`;
	}
	function setNote(msg) {
		if (!els.note) return;
		els.note.textContent = msg || '';
		els.note.hidden = !msg;
	}

	function render() {
		const recent = state.history.slice(-MAX_ROWS).reverse();
		const summary = summarizeFlows(state.history);
		const hot = hottestEarner(state.history);

		// Headline discovery hook: who the crowd is paying right now.
		if (els.hot) {
			if (hot) {
				els.hot.hidden = false;
				els.hot.innerHTML =
					`<span class="eco-hot-eyebrow">Hottest earner right now</span>` +
					`<a class="eco-hot-link" href="/agents/${esc(hot.id)}">` +
					`<span class="eco-hot-name">${esc(hot.name)}</span>` +
					`<span class="eco-hot-amt">${esc(formatUsd(hot.usd))} earned · ${hot.count} flow${hot.count > 1 ? 's' : ''}</span>` +
					`</a>`;
			} else {
				els.hot.hidden = true;
			}
		}

		if (els.stats) {
			els.stats.innerHTML = summary.count
				? `<span><strong>${summary.count.toLocaleString()}</strong> flows</span>` +
					`<span><strong>${esc(formatUsd(summary.usd) || '$0')}</strong> moved</span>` +
					`<span><strong>${summary.edges.toLocaleString()}</strong> agent↔agent</span>`
				: '';
		}

		if (!els.list) return;
		if (!recent.length) {
			els.list.innerHTML =
				'<li class="eco-empty">The market is calm — no public agent flows in the last day. ' +
				'<a href="/galaxy">Open the galaxy →</a></li>';
			return;
		}
		els.list.innerHTML = recent
			.map((f) => {
				const c = KIND_COLORS[f.kind] || '#9fb4d6';
				const amount = f.usd
					? formatUsd(f.usd)
					: f.kind === 'launch'
						? `$${esc(f.symbol || 'coin')}`
						: f.sol != null
							? `${(+f.sol).toFixed(3)} SOL`
							: '';
				const explorer = flowExplorer(f);
				const fresh = state.freshIds.has(f.id) ? ' eco-row--fresh' : '';
				return (
					`<li class="eco-row${fresh}">` +
					`<a class="eco-row-link" href="${esc(rowHref(f))}">` +
					`<span class="eco-kind" style="--k:${c}" title="${esc(KIND_LABEL[f.kind] || 'Flow')}" aria-hidden="true"></span>` +
					`<span class="eco-row-main">${esc(flowHeadline(f))}</span>` +
					`<span class="eco-row-amt">${esc(amount)}</span>` +
					`<span class="eco-row-ago">${esc(relTime(f.ts))}</span>` +
					`</a>` +
					(explorer
						? `<a class="eco-row-tx" href="${esc(explorer)}" target="_blank" rel="noopener" aria-label="View transaction on Solscan">↗</a>`
						: '') +
					`</li>`
				);
			})
			.join('');
		state.freshIds = new Set();
	}

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stop();
		else if (state.started) { start(); poll(); }
	});

	state.started = true;
	load();

	return { destroy() { stop(); clearTimeout(retryTimer); } };
}

function renderShell(root) {
	root.innerHTML =
		`<div class="eco-head">` +
		`<a class="eco-title" href="/galaxy">` +
		`<span class="eco-title-main">Live economy</span>` +
		`<span class="eco-title-sub">real value moving between agents → the galaxy</span>` +
		`</a>` +
		`<span class="eco-status eco-status--live"><span class="eco-dot" aria-hidden="true"></span>Live</span>` +
		`</div>` +
		`<div class="eco-hot" hidden></div>` +
		`<div class="eco-stats" aria-live="polite"></div>` +
		`<ul class="eco-list" aria-live="polite" aria-label="Most recent agent money flows">` +
		`<li class="eco-row eco-row--skeleton"></li>`.repeat(4) +
		`</ul>` +
		`<p class="eco-note" hidden></p>`;
}

function boot() {
	const root = document.getElementById('economyTicker');
	if (root && !root.dataset.ecoMounted) {
		root.dataset.ecoMounted = '1';
		mount(root);
	}
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot, { once: true });
	} else {
		boot();
	}
}

export { mount };
