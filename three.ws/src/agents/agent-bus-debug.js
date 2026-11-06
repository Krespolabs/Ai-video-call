// Agent Bus debug overlay — a developer tool, NOT product UI.
//
// Loaded only when the URL carries ?agentbus=1 (see agent-bus.js). It taps the
// wildcard subscriber and renders a live, scrolling log of every bus event in a
// fixed corner panel, so you can watch the nervous system fire: change the active
// agent, send a chat that recalls memory, add/forget a memory — each shows up
// here with its agentId, timestamp, and payload. This is the verification tool
// for the Foundation task; it never ships in the normal UI.

import { agentBus, AGENT_EVENTS } from './agent-bus.js';

const MAX_ROWS = 200;
const PANEL_ID = 'agentbus-debug';
// The wildcard subscription from the live panel, so a re-mount (after an SPA
// route swap wiped the body) can drop the stale one instead of leaking it.
let offWild = null;

// A stable, readable colour per event family so the stream is scannable.
const COLORS = {
	'memory:added': '#34d399',
	'memory:recalled': '#60a5fa',
	'memory:updated': '#fbbf24',
	'memory:forgotten': '#f87171',
	'brain:updated': '#a78bfa',
	'mood:changed': '#f472b6',
	'dream:created': '#c084fc',
	'action:taken': '#fb923c',
	'agent:changed': '#22d3ee',
};

function fmtTime(ts) {
	const d = ts ? new Date(ts) : new Date();
	if (Number.isNaN(d.getTime())) return String(ts);
	return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function summarize(type, payload) {
	const p = payload || {};
	switch (type) {
		case 'memory:recalled':
			return `${p.memories?.length ?? 0} recalled${p.semantic ? ' (semantic)' : ''}${p.query ? ` · “${String(p.query).slice(0, 40)}”` : ''}`;
		case 'memory:added':
		case 'memory:updated':
			return p.memory ? `${p.memory.type}: ${String(p.memory.content || '').slice(0, 48)}` : '';
		case 'memory:forgotten':
			return p.memoryId || '';
		case 'agent:changed':
			return p.agent?.name ? `→ ${p.agent.name}` : p.agentId ? `→ ${p.agentId}` : '(cleared)';
		case 'mood:changed':
			return p.mood || '';
		case 'dream:created':
			return p.title || p.insight ? String(p.title || p.insight).slice(0, 48) : '';
		case 'action:taken':
			return p.summary || p.kind || '';
		case 'brain:updated':
			return p.change || (p.toneTags ? p.toneTags.join(', ') : '');
		default:
			return '';
	}
}

/** Mount the overlay (idempotent). Safe to call repeatedly; re-mounts if the
 * panel was removed (e.g. a client-side route swap wiped the body). */
export function mountAgentBusDebug() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(PANEL_ID)) return; // already live
	if (offWild) {
		offWild(); // drop the subscriber from a panel that got wiped
		offWild = null;
	}

	const style = document.createElement('style');
	style.textContent = `
		#agentbus-debug{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:360px;max-width:calc(100vw - 24px);
			max-height:46vh;display:flex;flex-direction:column;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
			color:#e5e7eb;background:rgba(9,11,16,.92);border:1px solid rgba(255,255,255,.12);border-radius:12px;
			box-shadow:0 12px 40px rgba(0,0,0,.5);backdrop-filter:blur(8px);overflow:hidden}
		#agentbus-debug header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,.04);
			border-bottom:1px solid rgba(255,255,255,.08);cursor:default}
		#agentbus-debug header b{font-weight:600;letter-spacing:.02em}
		#agentbus-debug header .dot{width:7px;height:7px;border-radius:50%;background:#22d3ee;box-shadow:0 0 8px #22d3ee}
		#agentbus-debug header .count{margin-left:auto;opacity:.6}
		#agentbus-debug header button{appearance:none;border:1px solid rgba(255,255,255,.14);background:transparent;
			color:#e5e7eb;border-radius:6px;padding:2px 7px;cursor:pointer;font:inherit}
		#agentbus-debug header button:hover{background:rgba(255,255,255,.08)}
		#agentbus-debug header button:focus-visible{outline:2px solid #60a5fa;outline-offset:1px}
		#agentbus-debug .rows{overflow-y:auto;padding:4px 0}
		#agentbus-debug .row{display:grid;grid-template-columns:auto auto 1fr;gap:8px;padding:3px 10px;align-items:baseline}
		#agentbus-debug .row:hover{background:rgba(255,255,255,.04)}
		#agentbus-debug .row time{opacity:.5;font-variant-numeric:tabular-nums}
		#agentbus-debug .row .type{font-weight:600}
		#agentbus-debug .row .msg{opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		#agentbus-debug .empty{padding:14px 12px;opacity:.6}
		#agentbus-debug.collapsed .rows,#agentbus-debug.collapsed .empty{display:none}
		@media (prefers-reduced-motion:no-preference){#agentbus-debug .row{animation:abFade .25s ease}}
		@keyframes abFade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
	`;
	document.head.appendChild(style);

	const panel = document.createElement('section');
	panel.id = 'agentbus-debug';
	panel.setAttribute('role', 'log');
	panel.setAttribute('aria-label', 'Agent bus debug log');
	panel.innerHTML = `
		<header>
			<span class="dot" aria-hidden="true"></span>
			<b>agent bus</b>
			<span class="count" data-count>0 events</span>
			<button type="button" data-collapse aria-label="Collapse log">–</button>
			<button type="button" data-clear aria-label="Clear log">clear</button>
		</header>
		<div class="rows" data-rows></div>
		<div class="empty" data-empty>Listening on ${AGENT_EVENTS.length} event types. Trigger one — change the active agent, send a chat that recalls memory, add or forget a memory.</div>
	`;
	document.body.appendChild(panel);

	const rows = panel.querySelector('[data-rows]');
	const empty = panel.querySelector('[data-empty]');
	const countEl = panel.querySelector('[data-count]');
	let count = 0;

	panel.querySelector('[data-clear]').addEventListener('click', () => {
		rows.innerHTML = '';
		count = 0;
		countEl.textContent = '0 events';
		empty.style.display = '';
	});
	panel.querySelector('[data-collapse]').addEventListener('click', (e) => {
		const collapsed = panel.classList.toggle('collapsed');
		e.currentTarget.textContent = collapsed ? '+' : '–';
		e.currentTarget.setAttribute('aria-label', collapsed ? 'Expand log' : 'Collapse log');
	});

	offWild = agentBus.on('*', (payload, type) => {
		empty.style.display = 'none';
		const row = document.createElement('div');
		row.className = 'row';
		const color = COLORS[type] || '#9ca3af';
		const msg = summarize(type, payload);
		row.innerHTML = `<time>${fmtTime(payload?.ts)}</time><span class="type" style="color:${color}">${type}</span><span class="msg"></span>`;
		row.querySelector('.msg').textContent = msg;
		row.title = JSON.stringify(payload, null, 2);
		rows.appendChild(row);
		while (rows.children.length > MAX_ROWS) rows.removeChild(rows.firstChild);
		rows.scrollTop = rows.scrollHeight;
		count += 1;
		countEl.textContent = `${count} event${count === 1 ? '' : 's'}`;
	});

	console.info('[agent-bus] debug overlay active (?agentbus=1). window.__agentBus is live.');
}

export default mountAgentBusDebug;
