// Mood inspector — make the emotional state legible, not a black box.
//
// Renders the agent's current mood (the valence × arousal point + its discrete
// label), a "mood over time" sparkline from real history, the recent signals
// that actually moved it (each citing its source), and the emotional-sensitivity
// control. Two ways to mount:
//   • mountMoodInspector(host, { agentId })  — embed in the edit page.
//   • ?mood=1                                — floating dev overlay (active agent).
//
// For the active agent it binds live to the mood engine; for any other owned
// agent it reads the persisted snapshot + history straight from the API. No
// invented numbers anywhere — every value is the engine's real state or a real
// stored row.

import { moodEngine } from './mood-engine.js';
import { apiFetch } from '../api.js';
import { MOODS, moodLabel, BASELINE } from './mood-model.js';

const STYLE_ID = 'mood-inspector-style';

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = `
	.mood-insp { --bg:#0c0e14; --line:rgba(255,255,255,.09); --dim:rgba(255,255,255,.5);
		color:#e8ecf4; font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
		background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.01));
		border:1px solid var(--line); border-radius:14px; padding:16px; display:grid; gap:14px; }
	.mood-insp__head { display:flex; align-items:center; gap:12px; }
	.mood-insp__emoji { font-size:34px; line-height:1; filter:drop-shadow(0 0 8px var(--mood-color,#7c93b3)); }
	.mood-insp__label { font-size:18px; font-weight:650; letter-spacing:.2px; }
	.mood-insp__sub { color:var(--dim); font-size:12px; }
	.mood-insp__gauges { display:grid; gap:10px; }
	.mood-insp__gauge { display:grid; grid-template-columns:64px 1fr 44px; align-items:center; gap:10px; }
	.mood-insp__gname { color:var(--dim); }
	.mood-insp__track { position:relative; height:8px; border-radius:6px; background:rgba(255,255,255,.07); overflow:hidden; }
	.mood-insp__fill { position:absolute; top:0; bottom:0; border-radius:6px; transition:left .8s ease,width .8s ease,background .8s ease; }
	.mood-insp__val { text-align:right; font-variant-numeric:tabular-nums; color:var(--dim); }
	.mood-insp__spark { width:100%; height:54px; display:block; }
	.mood-insp__sectiontitle { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:2px 0 -4px; }
	.mood-insp__sens { display:grid; gap:8px; }
	.mood-insp__sensrow { display:flex; align-items:center; justify-content:space-between; }
	.mood-insp__sens input[type=range] { width:100%; accent-color:#7aa2ff; }
	.mood-insp__sensval { font-weight:600; }
	.mood-insp__signals { display:grid; gap:6px; max-height:168px; overflow:auto; }
	.mood-insp__signal { display:grid; grid-template-columns:10px 1fr auto; align-items:center; gap:9px;
		padding:6px 8px; border:1px solid var(--line); border-radius:9px; background:rgba(255,255,255,.02); }
	.mood-insp__dot { width:9px; height:9px; border-radius:50%; }
	.mood-insp__sigwhat { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.mood-insp__sigwhen { color:var(--dim); font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
	.mood-insp__empty { color:var(--dim); padding:8px 2px; }
	.mood-insp__err { color:#fca5a5; }
	.mood-insp--overlay { position:fixed; left:14px; bottom:14px; width:320px; z-index:2147483000;
		box-shadow:0 18px 50px rgba(0,0,0,.5); max-height:84vh; overflow:auto; }
	.mood-insp__close { margin-left:auto; background:none; border:1px solid var(--line); color:var(--dim);
		border-radius:8px; cursor:pointer; width:26px; height:26px; }
	.mood-insp__close:hover { color:#fff; }
	@media (prefers-reduced-motion: reduce){ .mood-insp__fill{ transition:none } }
	`;
	document.head.appendChild(el);
}

const SENS_LABEL = (s) => (s <= 0.02 ? 'Stoic' : s < 0.4 ? 'Reserved' : s < 0.7 ? 'Balanced' : 'Expressive');
const fmtAgo = (iso) => {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
};
const colorFor = (key) => (MOODS.find((m) => m.key === key) || MOODS[0]).color;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Build the valence sparkline (chronological). `rows` are history entries with
// valence + created_at; newest-first from the API, so we reverse.
function sparkline(rows) {
	const pts = rows
		.slice()
		.reverse()
		.map((r) => ({ v: Number(r.valence), key: r.label }))
		.filter((p) => Number.isFinite(p.v));
	if (pts.length < 2) return '<div class="mood-insp__empty">Not enough history yet — it builds as your agent feels things.</div>';
	const W = 280, H = 54, pad = 4;
	const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
	const y = (v) => pad + (1 - (v + 1) / 2) * (H - pad * 2); // valence -1..1 → bottom..top
	const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
	const last = pts[pts.length - 1];
	const mid = (H / 2).toFixed(1);
	return `<svg class="mood-insp__spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Mood valence over time">
		<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="rgba(255,255,255,.08)" stroke-width="1"/>
		<path d="${d}" fill="none" stroke="${colorFor(last.key)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
		<circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3" fill="${colorFor(last.key)}"/>
	</svg>`;
}

function gauge(name, value, frac, color) {
	const left = Math.max(0, Math.min(100, frac * 100));
	return `<div class="mood-insp__gauge">
		<span class="mood-insp__gname">${name}</span>
		<span class="mood-insp__track"><span class="mood-insp__fill" style="left:${(left - 2).toFixed(1)}%;width:4%;background:${color}"></span></span>
		<span class="mood-insp__val">${value}</span>
	</div>`;
}

/**
 * Mount the inspector into `host` for `agentId`.
 * @param {HTMLElement} host
 * @param {{ agentId: string, overlay?: boolean, onClose?: () => void }} opts
 * @returns {{ destroy: () => void }}
 */
export function mountMoodInspector(host, { agentId, overlay = false, onClose } = {}) {
	if (!host) return { destroy() {} };
	injectStyle();

	const root = document.createElement('div');
	root.className = 'mood-insp' + (overlay ? ' mood-insp--overlay' : '');
	host.appendChild(root);

	const live = agentId && agentId === moodEngine.snapshot().agentId;
	let history = [];
	let offEngine = null;
	let destroyed = false;

	function currentState() {
		if (live) {
			const snap = moodEngine.snapshot();
			return { valence: snap.valence, arousal: snap.arousal, mood: snap.mood, sensitivity: snap.sensitivity, signals: moodEngine.recentSignals() };
		}
		// Scoped (non-active) agent: derive from persisted history newest row.
		const top = history[0];
		const valence = top ? Number(top.valence) : BASELINE.valence;
		const arousal = top ? Number(top.arousal) : BASELINE.arousal;
		return {
			valence, arousal, mood: moodLabel(valence, arousal),
			sensitivity: scopedSensitivity,
			signals: history.map((r) => ({ source: r.source, label: r.source_label || r.source, mood: r.label, ts: r.created_at })),
		};
	}

	let scopedSensitivity = moodEngine.getSensitivity();

	function render() {
		if (destroyed) return;
		const s = currentState();
		const m = s.mood || moodLabel(s.valence, s.arousal);
		root.style.setProperty('--mood-color', m.color);
		const valencePct = `${s.valence >= 0 ? '+' : ''}${s.valence.toFixed(2)}`;
		const arousalPct = `${Math.round(s.arousal * 100)}%`;
		const sens = Math.round((s.sensitivity ?? 0.6) * 100) / 100;

		root.innerHTML = `
		<div class="mood-insp__head">
			<span class="mood-insp__emoji" aria-hidden="true">${m.emoji}</span>
			<span>
				<div class="mood-insp__label">${esc(m.label)}</div>
				<div class="mood-insp__sub">${live ? 'Live — updating from real signals' : 'Last known mood'}</div>
			</span>
			${overlay ? '<button type="button" class="mood-insp__close" aria-label="Close mood inspector">×</button>' : ''}
		</div>

		<div class="mood-insp__gauges">
			${gauge('Valence', valencePct, (s.valence + 1) / 2, m.color)}
			${gauge('Arousal', arousalPct, s.arousal, m.color)}
		</div>

		<div>
			<div class="mood-insp__sectiontitle">Mood over time</div>
			${sparkline(history)}
		</div>

		<div class="mood-insp__sens">
			<div class="mood-insp__sensrow">
				<span class="mood-insp__sectiontitle" style="margin:0">Emotional sensitivity</span>
				<span class="mood-insp__sensval" data-sensval>${SENS_LABEL(sens)}</span>
			</div>
			<input type="range" min="0" max="1" step="0.05" value="${sens}" aria-label="Emotional sensitivity (0 stoic to 1 expressive)" data-sens />
			<div class="mood-insp__sub">0 = stoic (never moves from baseline) · 1 = very expressive</div>
		</div>

		<div>
			<div class="mood-insp__sectiontitle">What moved it</div>
			<div class="mood-insp__signals" data-signals>${renderSignals(s.signals)}</div>
		</div>`;

		const range = root.querySelector('[data-sens]');
		const sensVal = root.querySelector('[data-sensval]');
		if (range) {
			range.addEventListener('input', () => {
				if (sensVal) sensVal.textContent = SENS_LABEL(Number(range.value));
			});
			range.addEventListener('change', () => applySensitivity(Number(range.value)));
		}
		const close = root.querySelector('.mood-insp__close');
		if (close) close.addEventListener('click', () => { destroy(); onClose?.(); });
	}

	function renderSignals(signals) {
		if (!signals || !signals.length) {
			return '<div class="mood-insp__empty">No signals yet. Chat with your agent, add a memory, or let it dream — its mood moves only on real events.</div>';
		}
		return signals.slice(0, 12).map((sig) => `
			<div class="mood-insp__signal">
				<span class="mood-insp__dot" style="background:${colorFor(sig.mood)}"></span>
				<span class="mood-insp__sigwhat" title="${esc(sig.label)}">${esc(sig.label)}</span>
				<span class="mood-insp__sigwhen">${esc(fmtAgo(sig.ts))}</span>
			</div>`).join('');
	}

	async function applySensitivity(value) {
		if (live) {
			await moodEngine.setSensitivity(value);
		} else {
			scopedSensitivity = Math.max(0, Math.min(1, value));
			try {
				await apiFetch(`/api/agents/${agentId}/mood/sensitivity`, {
					method: 'POST', headers: { 'content-type': 'application/json' },
					credentials: 'include', body: JSON.stringify({ sensitivity: scopedSensitivity }),
				});
			} catch { /* local UI still reflects the choice */ }
		}
	}

	async function loadHistory() {
		try {
			if (live) {
				history = await moodEngine.loadHistory();
			} else {
				const res = await apiFetch(`/api/agents/${agentId}/mood`, { credentials: 'include' });
				if (res.ok) {
					const data = await res.json();
					history = Array.isArray(data.history) ? data.history : [];
					if (data.mood && Number.isFinite(data.mood.sensitivity)) scopedSensitivity = data.mood.sensitivity;
				}
			}
		} catch { history = []; }
		render();
	}

	render();
	loadHistory();

	if (live) {
		offEngine = moodEngine.onChange(() => render());
	}

	function destroy() {
		destroyed = true;
		offEngine?.();
		root.remove();
	}

	return { destroy };
}

// Dev overlay — `?mood=1` mounts a floating inspector for the active agent. A
// parallel to `?agentbus=1`; out of the bundle until opted in.
if (typeof window !== 'undefined') {
	try {
		const flag = new URLSearchParams(window.location.search).get('mood');
		if (flag === '1' || flag === 'true') {
			const boot = () => {
				// Wait for the active agent to resolve so the overlay binds live.
				const mount = (id) => {
					const host = document.createElement('div');
					document.body.appendChild(host);
					mountMoodInspector(host, { agentId: id, overlay: true, onClose: () => host.remove() });
				};
				const id = moodEngine.snapshot().agentId;
				if (id) { mount(id); return; }
				const off = moodEngine.onChange((snap) => {
					if (snap.agentId) { off(); mount(snap.agentId); }
				});
			};
			if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
			else boot();
		}
	} catch { /* location unavailable */ }
}

export default mountMoodInspector;
