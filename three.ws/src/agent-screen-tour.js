// agent-screen-tour.js — the Coin World Tour overlay for /agent-screen.
//
// A guide agent (window.__tour, src/play/arena.js) streams a live walkthrough of
// the $THREE 3D world to the agent screen. Its screenshot frames are stamped
// "Tour · <waypoint>" (TOUR_PREFIX); its commentary arrives as type:'analysis'
// lines narrating what's climbing three.ws's OWN launch feed. This module paints a
// TOUR badge + the current waypoint over the live screen, and reveals the latest
// narration on hover/focus.
//
// It's deliberately self-contained and lazy: the badge only comes into existence
// once a real tour frame arrives, so a normal agent's live screen is untouched. No
// coin is promoted — the lines are the same factual launch-directory text the
// caster pushed (see src/tour-commentary.js).

import { TOUR_PREFIX } from './tour-commentary.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
	{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const STYLE = `
.asc-tour-badge{position:absolute;top:14px;left:14px;z-index:7;display:inline-flex;align-items:center;gap:7px;
	padding:6px 11px;border-radius:999px;font:600 11px/1 var(--font-mono,ui-monospace,monospace);letter-spacing:.04em;
	color:#e8ecff;background:rgba(12,14,22,.72);border:1px solid rgba(154,123,255,.45);
	box-shadow:0 6px 22px rgba(0,0,0,.35);backdrop-filter:blur(8px);cursor:default;outline:none;transition:border-color .2s}
.asc-tour-badge:hover,.asc-tour-badge:focus-visible{border-color:rgba(154,123,255,.85)}
.asc-tour-dot{width:7px;height:7px;border-radius:50%;background:#9a7bff;animation:ascTourPulse 1.8s ease-out infinite}
@keyframes ascTourPulse{0%{box-shadow:0 0 0 0 rgba(154,123,255,.55)}70%{box-shadow:0 0 0 7px rgba(154,123,255,0)}100%{box-shadow:0 0 0 0 rgba(154,123,255,0)}}
.asc-tour-tag{color:#9a7bff;font-weight:700}
.asc-tour-label{color:rgba(255,255,255,.82);max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.asc-tour-pop{position:absolute;top:calc(100% + 8px);left:0;min-width:220px;max-width:320px;padding:10px 12px;border-radius:12px;
	background:rgba(10,12,20,.94);border:1px solid rgba(154,123,255,.32);box-shadow:0 14px 40px rgba(0,0,0,.5);
	opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity .18s,transform .18s}
.asc-tour-badge:hover .asc-tour-pop,.asc-tour-badge:focus-within .asc-tour-pop{opacity:1;transform:none}
.asc-tour-pop-h{font:700 10px/1.2 var(--font-mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;color:#9a7bff;margin-bottom:7px}
.asc-tour-line{font:500 12px/1.45 Inter,system-ui,sans-serif;color:rgba(255,255,255,.78);padding:3px 0;border-top:1px solid rgba(255,255,255,.06)}
.asc-tour-line:first-child{border-top:none;color:#fff}`;

let badge = null;
let labelEl = null;
let popBody = null;
let active = false;
let lastSeen = 0;
const lines = [];

function ensure() {
	if (badge) return;
	const stage = document.querySelector('.asc-screen-stage');
	if (!stage) return;
	const css = document.createElement('style');
	css.textContent = STYLE;
	document.head.appendChild(css);
	badge = document.createElement('div');
	badge.className = 'asc-tour-badge';
	badge.tabIndex = 0;
	badge.innerHTML = `
		<span class="asc-tour-dot" aria-hidden="true"></span>
		<span class="asc-tour-tag">TOUR</span>
		<span class="asc-tour-label">On tour</span>
		<div class="asc-tour-pop">
			<div class="asc-tour-pop-h">Climbing the three.ws launch feed</div>
			<div class="asc-tour-pop-body">Listening for the guide…</div>
		</div>`;
	stage.appendChild(badge);
	labelEl = badge.querySelector('.asc-tour-label');
	popBody = badge.querySelector('.asc-tour-pop-body');
	// Retire the badge if tour frames stop arriving (guide walked off / feed dark).
	setInterval(() => {
		if (badge && badge.style.display !== 'none' && Date.now() - lastSeen > 14000) {
			badge.style.display = 'none';
			active = false;
		}
	}, 4000);
}

function onWaypoint(activity) {
	ensure();
	if (!badge) return;
	active = true;
	lastSeen = Date.now();
	badge.style.display = '';
	labelEl.textContent = activity.slice(TOUR_PREFIX.length).trim() || 'On tour';
}

function onCommentary(activity) {
	if (!popBody || !activity || lines[0] === activity) return;
	lines.unshift(activity);
	while (lines.length > 5) lines.pop();
	popBody.innerHTML = lines.map((l) => `<div class="asc-tour-line">${esc(l)}</div>`).join('');
}

// Feed every streamed frame through here. Screenshot frames stamped with the tour
// prefix reveal the badge + waypoint; analysis lines (only once a tour is live)
// stock the hover narration. Any other frame is ignored — no-op for normal agents.
export function handleTourFrame(frame) {
	if (!frame?.activity) return;
	if (frame.type === 'analysis') { if (active) onCommentary(frame.activity); return; }
	if (frame.activity.startsWith(TOUR_PREFIX)) onWaypoint(frame.activity);
}
