/**
 * Injected stylesheet for @three-ws/page-agent. Scoped under `.tw-pa-*` class
 * names and injected once. Honors prefers-reduced-motion and prefers-color-scheme,
 * and exposes `--tw-pa-accent` so each agent can tint its own chrome.
 */

const STYLE_ID = 'tw-page-agent-styles';

export const CSS = `
.tw-pa-root {
	position: fixed;
	z-index: 2147483000;
	--tw-pa-accent: #6366f1;
	--tw-pa-bg: rgba(17, 18, 24, 0.92);
	--tw-pa-fg: #f4f4f6;
	--tw-pa-muted: rgba(244, 244, 246, 0.6);
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	color: var(--tw-pa-fg);
	-webkit-font-smoothing: antialiased;
	box-sizing: border-box;
}
.tw-pa-root *, .tw-pa-root *::before, .tw-pa-root *::after { box-sizing: border-box; }
.tw-pa-root[data-pos="bottom-right"] { right: 20px; bottom: 20px; }
.tw-pa-root[data-pos="bottom-left"]  { left: 20px;  bottom: 20px; }
.tw-pa-root[data-pos="top-right"]    { right: 20px; top: 20px; }
.tw-pa-root[data-pos="top-left"]     { left: 20px;  top: 20px; }

.tw-pa-dock {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 8px;
	width: 240px;
	max-width: calc(100vw - 40px);
}

.tw-pa-stage {
	position: relative;
	width: 240px;
	height: 280px;
	max-width: calc(100vw - 40px);
	border-radius: 20px;
	overflow: hidden;
	background:
		radial-gradient(120% 80% at 50% 0%, color-mix(in srgb, var(--tw-pa-accent) 26%, transparent), transparent 70%),
		var(--tw-pa-bg);
	box-shadow: 0 18px 50px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset;
	transition: transform .35s cubic-bezier(.2,.8,.2,1), opacity .35s ease;
	cursor: grab;
}
.tw-pa-stage:active { cursor: grabbing; }
.tw-pa-root[data-state="collapsed"] .tw-pa-stage { display: none; }
.tw-pa-stage canvas { border-radius: inherit; }

.tw-pa-name {
	position: absolute; left: 12px; top: 10px;
	display: inline-flex; align-items: center; gap: 6px;
	padding: 4px 10px; border-radius: 999px;
	font-size: 12px; font-weight: 600; letter-spacing: .01em;
	background: rgba(0,0,0,0.35); backdrop-filter: blur(6px);
	border: 1px solid rgba(255,255,255,0.08);
}
.tw-pa-name::before {
	content: ''; width: 7px; height: 7px; border-radius: 50%;
	background: var(--tw-pa-accent); box-shadow: 0 0 8px var(--tw-pa-accent);
}
.tw-pa-root[data-state="speaking"] .tw-pa-name::before { animation: tw-pa-pulse 1s ease-in-out infinite; }

.tw-pa-caption {
	position: absolute; left: 10px; right: 10px; bottom: 10px;
	padding: 10px 12px; border-radius: 14px;
	font-size: 13px; line-height: 1.4;
	background: rgba(0,0,0,0.55); backdrop-filter: blur(8px);
	border: 1px solid rgba(255,255,255,0.08);
	opacity: 0; transform: translateY(8px);
	transition: opacity .25s ease, transform .25s ease;
	max-height: 45%; overflow: auto;
}
.tw-pa-caption[data-show="true"] { opacity: 1; transform: translateY(0); }

.tw-pa-prompts {
	display: flex; flex-direction: column; gap: 6px;
	max-height: 132px; overflow-y: auto;
}
.tw-pa-prompts[hidden] { display: none; }
.tw-pa-prompt {
	appearance: none; text-align: left; cursor: pointer;
	border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
	background: var(--tw-pa-bg); color: var(--tw-pa-fg);
	padding: 8px 12px; font-size: 12px; line-height: 1.35; font-family: inherit;
	box-shadow: 0 8px 22px -10px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04) inset;
	transition: background .15s ease, transform .1s ease, border-color .15s ease;
}
.tw-pa-prompt:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.2); }
.tw-pa-prompt:active { transform: scale(.98); }
.tw-pa-prompt:focus-visible { outline: 2px solid var(--tw-pa-accent); outline-offset: 2px; }
.tw-pa-prompts::-webkit-scrollbar { width: 4px; }
.tw-pa-prompts::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 2px; }

.tw-pa-bar {
	display: flex; align-items: center; gap: 6px;
	padding: 6px; border-radius: 16px;
	background: var(--tw-pa-bg);
	box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06) inset;
}
.tw-pa-btn {
	appearance: none; border: 0; cursor: pointer;
	width: 36px; height: 36px; border-radius: 11px;
	display: inline-flex; align-items: center; justify-content: center;
	background: rgba(255,255,255,0.06); color: var(--tw-pa-fg);
	transition: background .15s ease, transform .1s ease;
}
.tw-pa-btn:hover { background: rgba(255,255,255,0.14); }
.tw-pa-btn:active { transform: scale(.94); }
.tw-pa-btn:focus-visible { outline: 2px solid var(--tw-pa-accent); outline-offset: 2px; }
.tw-pa-btn[aria-pressed="true"] { background: color-mix(in srgb, var(--tw-pa-accent) 75%, transparent); color: #fff; }
.tw-pa-btn svg { width: 18px; height: 18px; pointer-events: none; }
.tw-pa-btn[data-grow] { width: auto; padding: 0 12px; gap: 6px; font-size: 13px; font-weight: 600; }
.tw-pa-spacer { flex: 1; }

/* Launcher pill shown when collapsed */
.tw-pa-launcher {
	appearance: none; border: 0; cursor: pointer;
	display: inline-flex; align-items: center; gap: 8px;
	padding: 10px 14px 10px 10px; border-radius: 999px;
	background: var(--tw-pa-bg); color: var(--tw-pa-fg);
	box-shadow: 0 12px 34px -10px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset;
	font-size: 13px; font-weight: 600;
	transition: transform .15s ease;
}
.tw-pa-launcher:hover { transform: translateY(-1px); }
.tw-pa-launcher .tw-pa-orb {
	width: 30px; height: 30px; border-radius: 50%;
	background: radial-gradient(circle at 35% 30%, #fff, var(--tw-pa-accent) 70%);
	box-shadow: 0 0 14px color-mix(in srgb, var(--tw-pa-accent) 60%, transparent);
}
.tw-pa-root[data-state="collapsed"] .tw-pa-dock { display: none; }
.tw-pa-root:not([data-state="collapsed"]) .tw-pa-launcher { display: none; }

/* Picker overlay */
.tw-pa-picker {
	position: fixed; inset: 0; z-index: 2147483001;
	display: flex; align-items: center; justify-content: center;
	padding: 24px;
	background: rgba(8,8,12,0.62); backdrop-filter: blur(6px);
	opacity: 0; pointer-events: none; transition: opacity .2s ease;
}
.tw-pa-picker[data-open="true"] { opacity: 1; pointer-events: auto; }
.tw-pa-panel {
	width: min(720px, 100%); max-height: min(80vh, 640px); overflow: auto;
	background: #14151c; color: var(--tw-pa-fg);
	border-radius: 24px; padding: 22px;
	box-shadow: 0 30px 80px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.07) inset;
	transform: translateY(12px) scale(.98); transition: transform .25s cubic-bezier(.2,.8,.2,1);
}
.tw-pa-picker[data-open="true"] .tw-pa-panel { transform: none; }
.tw-pa-panel h2 { margin: 0 0 2px; font-size: 19px; }
.tw-pa-panel p.tw-pa-sub { margin: 0 0 18px; color: var(--tw-pa-muted); font-size: 13px; }
.tw-pa-grid {
	display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;
}
.tw-pa-card {
	text-align: left; cursor: pointer; appearance: none;
	border: 1px solid rgba(255,255,255,0.08); border-radius: 16px;
	background: rgba(255,255,255,0.03); color: inherit;
	padding: 14px; display: flex; flex-direction: column; gap: 4px;
	transition: border-color .15s ease, background .15s ease, transform .1s ease;
}
.tw-pa-card:hover { background: rgba(255,255,255,0.07); transform: translateY(-2px); }
.tw-pa-card:focus-visible { outline: 2px solid var(--tw-pa-accent2, #6366f1); outline-offset: 2px; }
.tw-pa-card[aria-current="true"] { border-color: var(--tw-pa-accent2); background: color-mix(in srgb, var(--tw-pa-accent2) 16%, transparent); }
.tw-pa-swatch {
	width: 100%; aspect-ratio: 4 / 3; border-radius: 11px; margin-bottom: 8px;
	background: radial-gradient(120% 90% at 50% 18%, color-mix(in srgb, var(--tw-pa-accent2) 60%, transparent), #0c0d12 75%);
	display: flex; align-items: flex-end; justify-content: center;
	font-size: 40px; line-height: 1; padding-bottom: 8px;
	border: 1px solid rgba(255,255,255,0.06);
}
.tw-pa-card .tw-pa-cname { font-weight: 700; font-size: 15px; }
.tw-pa-card .tw-pa-ctag { font-size: 12px; color: var(--tw-pa-muted); }
.tw-pa-chip {
	align-self: flex-start; margin-top: 6px;
	font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
	padding: 3px 7px; border-radius: 999px;
	background: rgba(255,255,255,0.06); color: var(--tw-pa-muted);
}
.tw-pa-close {
	position: absolute; top: 18px; right: 22px;
}

@keyframes tw-pa-pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.6); opacity: .5 } }

@media (prefers-color-scheme: light) {
	.tw-pa-root { --tw-pa-bg: rgba(255,255,255,0.92); --tw-pa-fg: #15151b; --tw-pa-muted: rgba(20,20,28,0.6); }
	.tw-pa-name, .tw-pa-caption { background: rgba(255,255,255,0.7); color: #15151b; }
	.tw-pa-panel { background: #fbfbfd; color: #15151b; }
	.tw-pa-card { border-color: rgba(0,0,0,0.08); background: rgba(0,0,0,0.02); }
	.tw-pa-card:hover { background: rgba(0,0,0,0.05); }
}
@media (prefers-reduced-motion: reduce) {
	.tw-pa-stage, .tw-pa-caption, .tw-pa-panel, .tw-pa-launcher, .tw-pa-card, .tw-pa-prompt { transition: none; }
	.tw-pa-name::before { animation: none; }
}
@media (max-width: 480px) {
	.tw-pa-stage, .tw-pa-dock { width: min(70vw, 240px); }
	.tw-pa-stage { height: min(60vw, 280px); }
}
`;

let _injected = false;

export function injectStyles(doc = document) {
	if (_injected || doc.getElementById(STYLE_ID)) { _injected = true; return; }
	const el = doc.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CSS;
	doc.head.appendChild(el);
	_injected = true;
}
