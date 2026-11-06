// Styles for the Arena + Guild live views (Task 09), shipped as a string and
// injected once. Self-contained and namespaced under .agora-live-* so it can't
// collide with the scaffold, the economy layer or the trust surface. Honours
// prefers-reduced-motion and exposes a visible focus ring on every control.

let _injected = false;
export function injectArenaGuildCss() {
	if (_injected || document.getElementById('agora-live-styles')) { _injected = true; return; }
	const style = document.createElement('style');
	style.id = 'agora-live-styles';
	style.textContent = ARENA_GUILD_CSS;
	document.head.appendChild(style);
	_injected = true;
}

export const ARENA_GUILD_CSS = `
.agora-live-root {
	position: fixed; inset: 0; z-index: 60;
	display: grid; place-items: center;
	font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
	--lv-bg: #0c0f16;
	--lv-panel: rgba(18, 22, 31, 0.96);
	--lv-border: rgba(255, 255, 255, 0.12);
	--lv-text: #e8eef7;
	--lv-dim: #93a1b5;
	--lv-gold: #f0b429;
	--lv-arena: #ff6b57;
	--lv-guild: #38d39f;
	opacity: 0; pointer-events: none;
	transition: opacity .22s ease;
}
.agora-live-root.is-open { opacity: 1; pointer-events: auto; }
.agora-live-root * , .agora-live-root *::before { box-sizing: border-box; }
.agora-live-backdrop {
	position: absolute; inset: 0;
	background: radial-gradient(120% 120% at 50% 0%, rgba(8,10,15,.7), rgba(4,6,10,.9));
	backdrop-filter: blur(3px);
}
.agora-live-card {
	position: relative;
	width: min(920px, 94vw); max-height: 92vh;
	display: flex; flex-direction: column;
	background: var(--lv-panel);
	border: 1px solid var(--lv-border);
	border-radius: 16px;
	box-shadow: 0 30px 80px rgba(0,0,0,.55);
	color: var(--lv-text);
	overflow: hidden;
	transform: translateY(10px) scale(.99);
	transition: transform .22s cubic-bezier(.2,.7,.3,1);
}
.agora-live-root.is-open .agora-live-card { transform: none; }
.agora-live-card.is-arena { --lv-accent: var(--lv-arena); }
.agora-live-card.is-guild { --lv-accent: var(--lv-guild); }

.agora-live-head {
	display: flex; align-items: flex-start; gap: 12px;
	padding: 16px 18px 12px;
	border-bottom: 1px solid var(--lv-border);
	background: linear-gradient(180deg, color-mix(in srgb, var(--lv-accent, #888) 12%, transparent), transparent);
}
.agora-live-head-text { flex: 1 1 auto; min-width: 0; }
.agora-live-title {
	margin: 0; font-size: 1.12rem; font-weight: 750; letter-spacing: .2px;
	display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
}
.agora-live-typebadge {
	display: inline-flex; align-items: center; gap: 6px;
	font-size: .72rem; font-weight: 700; letter-spacing: .6px; text-transform: uppercase;
	padding: 3px 9px; border-radius: 999px;
	color: var(--lv-accent, #fff);
	background: color-mix(in srgb, var(--lv-accent, #888) 18%, transparent);
	border: 1px solid color-mix(in srgb, var(--lv-accent, #888) 40%, transparent);
}
.agora-live-sub { margin: 4px 0 0; font-size: .82rem; color: var(--lv-dim); display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.agora-live-prize { color: var(--lv-gold); font-weight: 700; }
.agora-live-close {
	flex: 0 0 auto; width: 34px; height: 34px; border-radius: 9px;
	border: 1px solid var(--lv-border); background: rgba(255,255,255,.04);
	color: var(--lv-text); font-size: 1rem; cursor: pointer; line-height: 1;
}
.agora-live-close:hover { background: rgba(255,255,255,.09); }
.agora-live-close:focus-visible { outline: 2px solid var(--lv-accent, #4ea1ff); outline-offset: 2px; }

.agora-live-stage {
	position: relative;
	height: 300px; min-height: 300px;
	background:
		radial-gradient(80% 120% at 50% 0%, rgba(255,255,255,.04), transparent),
		#0a0d13;
	border-bottom: 1px solid var(--lv-border);
	overflow: hidden;
}
.agora-live-stage canvas { display: block; width: 100% !important; height: 100% !important; }
.agora-live-finish {
	position:absolute; top:0; right:0; bottom:0; width: 4px;
	background: repeating-linear-gradient(180deg, #fff 0 10px, #222 10px 20px);
	opacity:.35; pointer-events:none;
}

.agora-live-body { padding: 14px 18px 18px; overflow: auto; }
.agora-live-status {
	display:flex; align-items:center; gap:10px; flex-wrap: wrap;
	font-size: .86rem; margin: 0 0 12px;
}
.agora-live-pill {
	display:inline-flex; align-items:center; gap:6px;
	padding: 4px 10px; border-radius: 999px;
	border: 1px solid var(--lv-border); background: rgba(255,255,255,.03);
	color: var(--lv-dim); font-weight: 600; font-size: .78rem;
}
.agora-live-pill.is-live { color: #ffd27a; border-color: rgba(240,180,41,.4); }
.agora-live-pill.is-settled { color: var(--lv-guild); border-color: rgba(56,211,159,.4); }
.agora-live-pill.is-expired { color: #ff9d8a; border-color: rgba(255,107,87,.4); }
.agora-live-pill .dot { width:7px; height:7px; border-radius:50%; background: currentColor; }
.agora-live-pill.is-live .dot { animation: agoraLivePulse 1.4s ease-in-out infinite; }
@keyframes agoraLivePulse { 0%,100%{opacity:1} 50%{opacity:.35} }

.agora-live-roster { display: flex; flex-direction: column; gap: 8px; }
.agora-live-row {
	display: grid; grid-template-columns: 26px 1fr auto; align-items: center; gap: 10px;
	padding: 8px 10px; border-radius: 10px;
	border: 1px solid var(--lv-border); background: rgba(255,255,255,.02);
}
.agora-live-row.is-won { border-color: color-mix(in srgb, var(--lv-gold) 55%, transparent); background: rgba(240,180,41,.08); }
.agora-live-row.is-lost { opacity: .55; }
.agora-live-rank { font-variant-numeric: tabular-nums; color: var(--lv-dim); font-weight: 700; text-align:center; }
.agora-live-rank.is-won { color: var(--lv-gold); }
.agora-live-who { min-width: 0; }
.agora-live-name { font-weight: 650; font-size: .92rem; display:flex; align-items:center; gap:7px; }
.agora-live-name .swatch { width: 9px; height: 9px; border-radius: 50%; flex:0 0 auto; }
.agora-live-meta { font-size: .76rem; color: var(--lv-dim); margin-top: 2px; display:flex; gap:8px; flex-wrap:wrap; }
.agora-live-bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,.08); overflow:hidden; margin-top:6px; }
.agora-live-bar > span { display:block; height:100%; border-radius:3px; background: var(--lv-accent, #4ea1ff); transition: width .5s cubic-bezier(.2,.7,.3,1); }
.agora-live-state {
	font-size: .74rem; font-weight: 700; letter-spacing:.4px; text-transform: uppercase;
	padding: 3px 8px; border-radius: 7px; white-space: nowrap;
	color: var(--lv-dim); background: rgba(255,255,255,.05);
}
.agora-live-state.is-won { color: #1b1206; background: var(--lv-gold); }
.agora-live-state.is-contributed { color: #04140e; background: var(--lv-guild); }
.agora-live-state.is-lost { color: #ff9d8a; background: rgba(255,107,87,.12); }
.agora-live-share { color: var(--lv-gold); font-weight: 700; }
.agora-live-tx { color: var(--lv-dim); text-decoration: none; border-bottom: 1px dotted currentColor; }
.agora-live-tx:hover { color: var(--lv-text); }

.agora-live-outcome {
	margin: 2px 0 14px; padding: 12px 14px; border-radius: 12px;
	border: 1px solid color-mix(in srgb, var(--lv-accent, #888) 35%, var(--lv-border));
	background: color-mix(in srgb, var(--lv-accent, #888) 10%, transparent);
	font-size: .9rem;
}
.agora-live-outcome strong { color: var(--lv-accent, #fff); }

.agora-live-empty, .agora-live-loading, .agora-live-error {
	padding: 26px 18px; text-align: center; color: var(--lv-dim);
}
.agora-live-error { color: #ff9d8a; }
.agora-live-skel { height: 40px; border-radius: 10px; background: linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.09), rgba(255,255,255,.04)); background-size: 200% 100%; animation: agoraLiveSkel 1.2s linear infinite; margin-bottom: 8px; }
@keyframes agoraLiveSkel { 0%{background-position: 200% 0} 100%{background-position: -200% 0} }

.agora-live-btn {
	display:inline-flex; align-items:center; gap:6px;
	padding: 7px 12px; border-radius: 9px; font-size: .82rem; font-weight: 650;
	border: 1px solid var(--lv-border); background: rgba(255,255,255,.05); color: var(--lv-text);
	cursor:pointer; text-decoration:none;
}
.agora-live-btn:hover { background: rgba(255,255,255,.1); }
.agora-live-btn:focus-visible { outline: 2px solid var(--lv-accent, #4ea1ff); outline-offset: 2px; }

.agora-live-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }

@media (prefers-reduced-motion: reduce) {
	.agora-live-root, .agora-live-card, .agora-live-bar > span { transition: none; }
	.agora-live-pill.is-live .dot { animation: none; }
	.agora-live-skel { animation: none; }
}
`;
