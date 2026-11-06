// Reputation Arena — turns the live agent wall into a ranked competition.
//
// On /agents-live every card already streams a live screen; this layer stamps
// each one with the agent's REAL wallet-trust reputation (tier badge + score
// chip), then continuously reorders the wall so the most-trusted agents rise to
// the top. The numbers come straight from /api/agents/reputation-batch (the same
// non-gameable score the trust badge shows everywhere else) via the shared
// fetchReputationBatch — nothing is computed or faked here. The ordering itself
// is the pure, unit-tested rankArena() from ./shared/arena-rank.js.
//
// Reorders are animated with FLIP: we measure each card's box before and after
// the DOM move and play the delta as a transform, so cards glide to their new
// rank instead of jumping. A card that climbs pulses its tier accent. Live SSE
// streams and canvases are preserved because we MOVE the existing card nodes
// (never recreate them).

import { fetchReputationBatch } from './shared/agent-reputation.js';
import { rankArena } from './shared/arena-rank.js';

const REFRESH_MS = 45_000; // reputation moves slowly — poll on a calm cadence
const SCHEDULE_DEBOUNCE_MS = 220;

const SHIELD =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const st = document.createElement('style');
	st.id = 'al-arena-style';
	st.textContent = `
.al-rep-chip-slot{display:inline-flex;vertical-align:middle;margin-left:6px}
.al-rep-chip{display:inline-flex;align-items:center;gap:4px;font:600 10px/1 var(--font-mono,ui-monospace,monospace);
 padding:2px 6px;border-radius:999px;color:var(--rep-accent,#c4b5fd);white-space:nowrap;
 background:color-mix(in srgb,var(--rep-accent,#c4b5fd) 13%,transparent);
 border:1px solid color-mix(in srgb,var(--rep-accent,#c4b5fd) 32%,transparent)}
.al-rep-chip svg{width:10px;height:10px;opacity:.9}
.al-rep-chip-tier{letter-spacing:.02em}
.al-rep-chip-score{padding-left:4px;color:#fff;border-left:1px solid color-mix(in srgb,var(--rep-accent,#c4b5fd) 32%,transparent)}
.al-rep-chip--new{color:#9ca3af;background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12)}
.al-card{will-change:transform}
.al-card--climbed{animation:al-rep-climb 1.15s ease-out}
@keyframes al-rep-climb{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--rep-accent,#9a7bff) 65%,transparent)}100%{box-shadow:0 0 0 14px rgba(0,0,0,0)}}
@media (prefers-reduced-motion:reduce){.al-card--climbed{animation:none}}`;
	document.head.appendChild(st);
}

function chipHTML(rep) {
	if (!rep) return '';
	if (rep.isNew) {
		return `<span class="al-rep-chip al-rep-chip--new" title="New agent — no on-chain track record yet">✦ New</span>`;
	}
	const score = Math.round(Number(rep.score));
	if (!Number.isFinite(score)) return '';
	const tip = `Wallet trust ${score}/100 · ${rep.tierLabel || ''} — every point earned through real on-chain activity.`;
	return (
		`<span class="al-rep-chip" style="--rep-accent:${esc(rep.accent || '#c4b5fd')}" title="${esc(tip)}">` +
		SHIELD +
		`<span class="al-rep-chip-tier">${esc(rep.tierLabel || '')}</span>` +
		`<span class="al-rep-chip-score">${score}</span>` +
		`</span>`
	);
}

/**
 * Create the arena controller bound to the wall's grid and per-card state map.
 *
 * @param {object} ctx
 * @param {HTMLElement} ctx.grid           the card container
 * @param {Map<string,object>} ctx.cards   agentId → card state ({ card } node)
 * @param {boolean} [ctx.reducedMotion]    skip FLIP animation when true
 * @returns {{ start():void, schedule():void, refresh():Promise<void> }}
 */
export function createArena({ grid, cards, reducedMotion = false }) {
	ensureStyles();
	let _scheduleTimer = null;
	let _interval = null;
	let _running = false;

	function applyChip(state) {
		const meta = state.card.querySelector('.al-card-meta');
		if (!meta) return;
		const html = chipHTML(state.rep);
		let slot = meta.querySelector('.al-rep-chip-slot');
		if (!html) {
			slot?.remove();
			return;
		}
		if (!slot) {
			slot = document.createElement('span');
			slot.className = 'al-rep-chip-slot';
			const name = meta.querySelector('.al-card-name');
			if (name) name.appendChild(slot);
			else meta.appendChild(slot);
		}
		slot.innerHTML = html;
		if (state.rep?.accent) state.card.style.setProperty('--rep-accent', state.rep.accent);
	}

	// FLIP reorder: move existing card nodes into ranked order and animate the
	// delta. Returns silently when the order is already correct so an unchanged
	// wall never animates.
	function flipReorder() {
		const nodes = [...grid.querySelectorAll('.al-card')];
		if (nodes.length < 2) return;

		const entries = nodes.map((n) => ({ id: n.dataset.agentId, rep: cards.get(n.dataset.agentId)?.rep }));
		const orderedIds = rankArena(entries);
		const currentIds = nodes.map((n) => n.dataset.agentId);
		if (orderedIds.every((id, i) => id === currentIds[i])) return; // already ranked

		const oldIndex = new Map(currentIds.map((id, i) => [id, i]));
		const first = reducedMotion ? null : new Map(nodes.map((n) => [n, n.getBoundingClientRect()]));
		const byId = new Map(nodes.map((n) => [n.dataset.agentId, n]));

		// Reorder the DOM in one pass (a fragment keeps it to a single reflow).
		const frag = document.createDocumentFragment();
		for (const id of orderedIds) {
			const n = byId.get(id);
			if (n) frag.appendChild(n);
		}
		grid.appendChild(frag);

		// Flag the climbers so they pulse, regardless of motion preference.
		orderedIds.forEach((id, newIdx) => {
			if ((oldIndex.get(id) ?? newIdx) > newIdx) {
				const n = byId.get(id);
				if (!n) return;
				n.classList.remove('al-card--climbed');
				void n.offsetWidth; // restart the animation
				n.classList.add('al-card--climbed');
			}
		});

		if (reducedMotion || !first) return;

		// FLIP: invert to the old position, then release to the new one.
		for (const n of nodes) {
			const f = first.get(n);
			const last = n.getBoundingClientRect();
			const dx = f.left - last.left;
			const dy = f.top - last.top;
			if (!dx && !dy) continue;
			n.style.transition = 'none';
			n.style.transform = `translate(${dx}px, ${dy}px)`;
		}
		requestAnimationFrame(() => {
			for (const n of nodes) {
				if (!n.style.transform) continue;
				n.style.transition = 'transform 460ms cubic-bezier(.22,.61,.36,1)';
				n.style.transform = '';
				const cleanup = () => {
					n.style.transition = '';
					n.removeEventListener('transitionend', cleanup);
				};
				n.addEventListener('transitionend', cleanup);
			}
		});
	}

	async function refresh() {
		if (typeof document !== 'undefined' && document.hidden) return;
		const ids = [...cards.keys()];
		if (!ids.length) return;
		let map;
		try {
			map = await fetchReputationBatch(ids);
		} catch {
			return; // chips stay in their resting state; ordering is left untouched
		}
		for (const id of ids) {
			const state = cards.get(id);
			if (!state) continue;
			if (map[id]) state.rep = map[id];
			applyChip(state);
		}
		flipReorder();
	}

	function schedule() {
		if (_scheduleTimer) return;
		_scheduleTimer = setTimeout(() => {
			_scheduleTimer = null;
			refresh();
		}, SCHEDULE_DEBOUNCE_MS);
	}

	function start() {
		if (_running) return;
		_running = true;
		refresh();
		_interval = setInterval(() => {
			if (typeof document === 'undefined' || !document.hidden) refresh();
		}, REFRESH_MS);
	}

	return { start, schedule, refresh, _stop: () => clearInterval(_interval) };
}
