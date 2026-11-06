// Styles for the playable Commons (player mode), shipped as a string and
// injected once by player-mode.js — the humans.css.js pattern. Namespaced under
// .agora-p-* so it can't collide with the scaffold (agora.css) or the other
// Agora layers. Honours prefers-reduced-motion and gives every interactive
// element hover/active/focus states.

let _injected = false;
export function injectPlayerCss() {
	if (_injected || typeof document === 'undefined') return;
	_injected = true;
	const style = document.createElement('style');
	style.id = 'agora-player-css';
	style.textContent = PLAYER_CSS;
	document.head.appendChild(style);
}

const PLAYER_CSS = `
.agora-p-root {
	--p-bg: rgba(12, 15, 22, 0.82);
	--p-border: rgba(255, 255, 255, 0.12);
	--p-text: #e8eef7;
	--p-dim: #93a1b5;
	--p-accent: #6ea8ff;
	--p-ok: #36d399;
	--p-err: #ff6b6b;
	position: fixed;
	inset: 0;
	pointer-events: none;
	z-index: 30;
	font-family: Inter, system-ui, sans-serif;
	color: var(--p-text);
}

/* ── Interaction prompt (press E / tap) ────────────────────────────────── */
.agora-p-prompt {
	position: absolute;
	left: 50%;
	bottom: 118px;
	transform: translateX(-50%) translateY(6px);
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 16px;
	background: var(--p-bg);
	border: 1px solid var(--p-border);
	border-radius: 14px;
	backdrop-filter: blur(10px);
	box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
	opacity: 0;
	transition: opacity 0.18s ease, transform 0.18s ease;
	pointer-events: auto;
	cursor: pointer;
	border-left: 3px solid var(--p-accent);
	max-width: min(86vw, 460px);
}
.agora-p-prompt[data-show] { opacity: 1; transform: translateX(-50%) translateY(0); }
.agora-p-prompt:hover { border-color: var(--p-accent); }
.agora-p-prompt:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
.agora-p-prompt kbd {
	flex: none;
	min-width: 26px;
	text-align: center;
	padding: 3px 7px;
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.10);
	border: 1px solid var(--p-border);
	font: 700 12px/1.4 Inter, system-ui, sans-serif;
}
.agora-p-prompt-text { display: flex; flex-direction: column; min-width: 0; }
.agora-p-prompt-title {
	font-weight: 650; font-size: 14px;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.agora-p-prompt-sub {
	font-size: 12px; color: var(--p-dim);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── Presence pill (online humans) ─────────────────────────────────────── */
.agora-p-presence {
	position: absolute;
	top: 14px;
	right: 14px;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 8px 13px;
	background: var(--p-bg);
	border: 1px solid var(--p-border);
	border-radius: 999px;
	backdrop-filter: blur(10px);
	font-size: 12.5px;
	pointer-events: auto;
	border: 1px solid var(--p-border);
	cursor: default;
}
.agora-p-presence[data-clickable] { cursor: pointer; }
.agora-p-presence[data-clickable]:hover { border-color: var(--p-accent); }
.agora-p-presence:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
.agora-p-presence .dot {
	width: 8px; height: 8px; border-radius: 50%;
	background: var(--p-dim);
	flex: none;
}
.agora-p-presence[data-state="online"] .dot { background: var(--p-ok); box-shadow: 0 0 8px var(--p-ok); }
.agora-p-presence[data-state="connecting"] .dot { background: var(--p-accent); animation: agora-p-pulse 1.1s ease-in-out infinite; }
.agora-p-presence[data-state="solo"] .dot,
.agora-p-presence[data-state="offline"] .dot { background: var(--p-dim); }
@keyframes agora-p-pulse { 50% { opacity: 0.35; } }

/* ── Chat ──────────────────────────────────────────────────────────────── */
.agora-p-chat {
	position: absolute;
	left: 14px;
	bottom: 64px; /* clears the #agora-pop population pill (bottom-left, z-10) */
	width: min(78vw, 340px);
	display: flex;
	flex-direction: column;
	gap: 6px;
	pointer-events: auto;
}
.agora-p-chat-log {
	display: flex;
	flex-direction: column;
	gap: 4px;
	max-height: 132px;
	overflow: hidden;
	justify-content: flex-end;
	mask-image: linear-gradient(to bottom, transparent, black 26%);
}
.agora-p-chat-line {
	font-size: 12.5px;
	line-height: 1.45;
	padding: 4px 10px;
	background: rgba(12, 15, 22, 0.66);
	border-radius: 9px;
	width: fit-content;
	max-width: 100%;
	overflow-wrap: anywhere;
	animation: agora-p-rise 0.22s ease;
}
.agora-p-chat-line b { color: var(--p-accent); font-weight: 650; }
@keyframes agora-p-rise { from { opacity: 0; transform: translateY(5px); } }
.agora-p-chat-row { display: flex; gap: 6px; }
.agora-p-chat-input {
	flex: 1;
	min-width: 0;
	padding: 9px 12px;
	background: var(--p-bg);
	border: 1px solid var(--p-border);
	border-radius: 11px;
	color: var(--p-text);
	font: 13px Inter, system-ui, sans-serif;
	backdrop-filter: blur(10px);
}
.agora-p-chat-input::placeholder { color: var(--p-dim); }
.agora-p-chat-input:focus { outline: none; border-color: var(--p-accent); }
.agora-p-chat-send {
	flex: none;
	padding: 0 14px;
	border-radius: 11px;
	border: 1px solid var(--p-border);
	background: var(--p-bg);
	color: var(--p-text);
	font: 600 13px Inter, system-ui, sans-serif;
	cursor: pointer;
	transition: border-color 0.15s ease, background 0.15s ease;
}
.agora-p-chat-send:hover { border-color: var(--p-accent); }
.agora-p-chat-send:active { background: rgba(110, 168, 255, 0.18); }
.agora-p-chat-send:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }

/* Speech bubbles above remote players (DOM, projected per frame). */
.agora-p-bubbles { position: absolute; inset: 0; overflow: hidden; }
.agora-p-bubble {
	position: absolute;
	transform: translate(-50%, -100%);
	max-width: 220px;
	padding: 7px 11px;
	background: rgba(245, 248, 255, 0.96);
	color: #10151f;
	font-size: 12.5px;
	line-height: 1.4;
	border-radius: 12px;
	border-bottom-left-radius: 3px;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	overflow-wrap: anywhere;
	animation: agora-p-rise 0.2s ease;
	will-change: transform;
}

/* ── Touch controls ────────────────────────────────────────────────────── */
.agora-p-stick {
	position: absolute;
	left: 0;
	bottom: 64px;
	width: 46vw;
	max-width: 240px;
	height: 200px;
	pointer-events: auto;
	touch-action: none;
	display: none;
}
.agora-p-actions {
	position: absolute;
	right: 12px;
	bottom: 84px;
	display: none;
	flex-direction: column;
	gap: 10px;
	pointer-events: auto;
}
.agora-p-action-btn {
	width: 58px; height: 58px;
	border-radius: 50%;
	border: 1px solid var(--p-border);
	background: var(--p-bg);
	color: var(--p-text);
	font: 700 13px Inter, system-ui, sans-serif;
	backdrop-filter: blur(8px);
	cursor: pointer;
	transition: transform 0.12s ease, border-color 0.12s ease;
	touch-action: manipulation;
}
.agora-p-action-btn:active { transform: scale(0.92); border-color: var(--p-accent); }
.agora-p-action-btn:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
@media (hover: none), (max-width: 640px) {
	.agora-p-stick { display: block; }
	.agora-p-actions { display: flex; }
	.agora-p-chat { bottom: 76px; width: min(60vw, 260px); }
	.agora-p-prompt { bottom: 170px; }
}

@media (prefers-reduced-motion: reduce) {
	.agora-p-prompt, .agora-p-chat-line, .agora-p-bubble { animation: none; transition: none; }
	.agora-p-presence[data-state="connecting"] .dot { animation: none; }
}

/* ── On-chain (BNB) presence toggle — prompt 16 ───────────────────────────
   Top-LEFT (mirrors the humans-presence pill's top offset on the opposite
   side) — the entire right column above ~64px belongs to the economy
   layer's job-board panel (agora-econ-board-panel, z-index 40), which both
   visually and pointer-event-wise sits above anything placed there. OFF by
   default; .agora-oc-confirm is the "gracefully cancelable" opt-in prompt
   shown only the first time a browser turns this on (no stored key yet). */
.agora-oc-wrap {
	position: absolute;
	top: 14px;
	left: 14px;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 8px;
	pointer-events: auto;
	max-width: min(86vw, 300px);
}
.agora-oc-toggle {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 8px 13px;
	background: var(--p-bg);
	border: 1px solid var(--p-border);
	border-radius: 999px;
	backdrop-filter: blur(10px);
	font: 600 12px Inter, system-ui, sans-serif;
	color: var(--p-text);
	cursor: pointer;
	transition: border-color 0.15s ease, background 0.15s ease;
}
.agora-oc-toggle:hover:not(:disabled) { border-color: var(--p-accent); }
.agora-oc-toggle:active:not(:disabled) { background: rgba(110, 168, 255, 0.18); }
.agora-oc-toggle:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
.agora-oc-toggle:disabled { cursor: not-allowed; opacity: 0.55; }
.agora-oc-toggle .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--p-dim); flex: none; }
.agora-oc-toggle[data-state="off"] .dot { background: var(--p-dim); }
.agora-oc-toggle[data-state="connecting"] .dot { background: var(--p-accent); animation: agora-p-pulse 1.1s ease-in-out infinite; }
.agora-oc-toggle[data-state="on"] .dot { background: var(--p-ok); box-shadow: 0 0 8px var(--p-ok); }
.agora-oc-toggle[data-state="on-selfpay"] .dot { background: #f5b942; box-shadow: 0 0 8px #f5b942; }
.agora-oc-toggle[data-state="on-nofunds"] .dot { background: var(--p-err); }
.agora-oc-toggle[data-state="unavailable"] .dot { background: var(--p-dim); }
.agora-oc-confirm {
	width: 100%;
	padding: 12px;
	background: var(--p-bg);
	border: 1px solid var(--p-border);
	border-radius: 14px;
	backdrop-filter: blur(10px);
	box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
	animation: agora-p-rise 0.18s ease;
}
.agora-oc-confirm p { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--p-dim); }
.agora-oc-confirm-row { display: flex; gap: 8px; justify-content: flex-end; }
.agora-oc-btn {
	padding: 7px 13px;
	border-radius: 9px;
	border: 1px solid var(--p-border);
	background: transparent;
	color: var(--p-text);
	font: 600 12px Inter, system-ui, sans-serif;
	cursor: pointer;
	transition: border-color 0.12s ease, background 0.12s ease;
}
.agora-oc-btn:hover { border-color: var(--p-accent); }
.agora-oc-btn:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
.agora-oc-btn-primary { background: var(--p-accent); border-color: var(--p-accent); color: #0b1220; }
.agora-oc-btn-primary:hover { filter: brightness(1.08); }
.agora-oc-hint {
	width: 100%;
	padding: 9px 12px;
	background: var(--p-bg);
	border: 1px solid var(--p-border);
	border-radius: 11px;
	backdrop-filter: blur(10px);
	font-size: 11.5px;
	line-height: 1.45;
	color: var(--p-dim);
	animation: agora-p-rise 0.2s ease;
}
@media (hover: none), (max-width: 640px) {
	.agora-oc-wrap { top: 8px; left: 8px; max-width: 62vw; }
}
@media (prefers-reduced-motion: reduce) {
	.agora-oc-confirm, .agora-oc-hint { animation: none; }
	.agora-oc-toggle[data-state="connecting"] .dot { animation: none; }
}
`;
