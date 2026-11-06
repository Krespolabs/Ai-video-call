/**
 * The designed chrome around a living body: name plate, conversational-state chip,
 * loading skeleton, and an actionable error card.
 *
 * EmbodimentStage renders the body; this renders everything the user reads ABOUT
 * the body — so every state the stage can be in (loading, idle, listening,
 * thinking, speaking, error) has a designed surface instead of a bare canvas. It's
 * pure DOM + CSS, no framework, reduced-motion aware, and shared by both the Apps
 * SDK embed and the local demo harness so they look identical.
 */

const STATE_LABEL = {
	loading: 'Waking up',
	idle: 'Listening',
	listening: 'Listening',
	thinking: 'Thinking',
	speaking: 'Speaking',
	error: 'Trouble',
};
const STATE_DOT = {
	loading: '#a78bfa', idle: '#5eead4', listening: '#5eead4',
	thinking: '#fbbf24', speaking: '#f472b6', error: '#fb7185',
};
const EMOTION_GLYPH = {
	neutral: '•', joy: '☺', sad: '☹', angry: '✖', surprised: '!', thinking: '…',
};

const CSS = `
.emb{position:absolute;inset:0;overflow:hidden;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8e8ee}
.emb__stage{position:absolute;inset:0}
.emb__plate{position:absolute;left:14px;top:12px;display:flex;align-items:center;gap:9px;
	padding:7px 12px 7px 10px;border-radius:999px;background:rgba(14,14,20,.72);
	border:1px solid rgba(167,139,250,.28);backdrop-filter:blur(10px);box-shadow:0 6px 22px rgba(0,0,0,.38);
	max-width:calc(100% - 28px)}
.emb__dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--emb-dot,#5eead4);
	box-shadow:0 0 9px var(--emb-dot,#5eead4);transition:background .3s,box-shadow .3s}
.emb__name{font-weight:700;font-size:13px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
.emb__state{font-size:11px;font-weight:600;color:#aab;letter-spacing:.02em;border-left:1px solid rgba(255,255,255,.14);padding-left:8px;white-space:nowrap}
.emb__emotion{font-size:11px;font-weight:700;color:var(--emb-dot,#5eead4)}
.emb__pulse .emb__dot{animation:emb-pulse 1.1s ease-in-out infinite}
@keyframes emb-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.45);opacity:.55}}
.emb__note{position:absolute;left:14px;bottom:12px;font-size:11px;color:#8b8b98;background:rgba(14,14,20,.6);
	padding:4px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.08);max-width:calc(100% - 28px)}
.emb__identity{position:absolute;right:14px;top:12px;display:flex;align-items:center;gap:6px;
	padding:6px 10px;border-radius:999px;background:rgba(14,14,20,.72);
	border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(10px);box-shadow:0 6px 22px rgba(0,0,0,.38);
	max-width:calc(100% - 28px);transition:opacity .25s}
.emb__identity[hidden]{display:none!important}
.emb__id-aura{width:8px;height:8px;border-radius:50%;flex:none;background:var(--emb-aura,#5b6472);
	box-shadow:0 0 8px var(--emb-aura,#5b6472)}
.emb__id-badge{font-size:11px;font-weight:700;color:var(--emb-cosmetic,#c2793b)}
.emb__id-name{font-size:11px;font-weight:600;color:#5eead4;border-left:1px solid rgba(255,255,255,.14);padding-left:6px;
	display:flex;align-items:center;gap:3px}
.emb__id-name::before{content:'✓';font-size:10px}
.emb__identity--muted{opacity:.55}
.emb__id-muted-note{font-size:10px;color:#8b8b98;font-style:italic}
.emb__skeleton{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
	background:radial-gradient(120% 120% at 50% 0%,#1a1a24 0%,#0c0c12 70%)}
.emb__skel-body{width:90px;height:200px;border-radius:40px 40px 18px 18px;
	background:linear-gradient(110deg,rgba(255,255,255,.05) 30%,rgba(255,255,255,.14) 50%,rgba(255,255,255,.05) 70%);
	background-size:220% 100%;animation:emb-shimmer 1.4s linear infinite}
.emb__skel-head{position:absolute;top:calc(50% - 150px);left:50%;transform:translateX(-50%);width:64px;height:64px;border-radius:50%;
	background:linear-gradient(110deg,rgba(255,255,255,.06) 30%,rgba(255,255,255,.16) 50%,rgba(255,255,255,.06) 70%);
	background-size:220% 100%;animation:emb-shimmer 1.4s linear infinite}
@keyframes emb-shimmer{0%{background-position:120% 0}100%{background-position:-120% 0}}
.emb__error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
	text-align:center;padding:24px;background:radial-gradient(120% 120% at 50% 0%,#241a1f 0%,#0c0c12 70%)}
.emb__error h3{margin:0;font-size:15px;color:#fecdd3}
.emb__error p{margin:0;font-size:12.5px;color:#b9939b;max-width:280px;line-height:1.5}
.emb__retry{margin-top:6px;appearance:none;border:1px solid rgba(251,113,133,.5);background:rgba(251,113,133,.12);
	color:#fecdd3;font:600 12px Inter,system-ui;padding:7px 16px;border-radius:9px;cursor:pointer;transition:background .15s,transform .1s}
.emb__retry:hover{background:rgba(251,113,133,.22)}.emb__retry:active{transform:scale(.97)}
.emb__retry:focus-visible{outline:2px solid #fb7185;outline-offset:2px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.emb__skel-body,.emb__skel-head,.emb__pulse .emb__dot{animation:none}}
`;

let _styleInjected = false;
function ensureStyle(doc) {
	if (_styleInjected) return;
	const s = doc.createElement('style');
	s.textContent = CSS;
	(doc.head || doc.documentElement).appendChild(s);
	_styleInjected = true;
}

/**
 * Mount the overlay chrome into a positioned container. Returns a controller the
 * stage's onState callback drives.
 * @param {HTMLElement} container
 * @param {{ onRetry?: ()=>void }} [opts]
 */
export function mountOverlay(container, opts = {}) {
	const doc = container.ownerDocument || document;
	ensureStyle(doc);
	const cs = getComputedStyle(container);
	if (cs.position === 'static') container.style.position = 'relative';

	const root = doc.createElement('div');
	root.className = 'emb';
	root.innerHTML = `
		<div class="emb__skeleton" data-skel>
			<div class="emb__skel-head"></div><div class="emb__skel-body"></div>
		</div>
		<div class="emb__plate" data-plate hidden>
			<span class="emb__dot" data-dot></span>
			<span class="emb__name" data-name>Agent</span>
			<span class="emb__state" data-state>Waking up</span>
			<span class="emb__emotion" data-emotion hidden></span>
		</div>
		<div class="emb__note" data-note hidden></div>
		<div class="emb__identity" data-identity hidden>
			<span class="emb__id-aura" data-id-aura title="Reputation"></span>
			<span class="emb__id-badge" data-id-badge></span>
			<span class="emb__id-name" data-id-name hidden></span>
			<span class="emb__id-muted-note" data-id-muted hidden>low balance</span>
		</div>
		<div class="emb__error" data-error hidden>
			<h3>This avatar didn't load</h3>
			<p data-error-msg>The 3D model couldn't be reached. Check the link and try again.</p>
			<button class="emb__retry" type="button" data-retry>Try again</button>
		</div>`;
	container.appendChild(root);

	const $ = (sel) => root.querySelector(sel);
	const els = {
		skel: $('[data-skel]'), plate: $('[data-plate]'), dot: $('[data-dot]'),
		name: $('[data-name]'), state: $('[data-state]'), emotion: $('[data-emotion]'),
		note: $('[data-note]'), error: $('[data-error]'), errorMsg: $('[data-error-msg]'), retry: $('[data-retry]'),
		identity: $('[data-identity]'), idAura: $('[data-id-aura]'), idBadge: $('[data-id-badge]'),
		idName: $('[data-id-name]'), idMuted: $('[data-id-muted]'),
	};
	els.retry.addEventListener('click', () => opts.onRetry?.());

	function setName(name) {
		if (name) els.name.textContent = name;
	}

	function setState(state, detail = {}) {
		if (state === 'error') {
			els.error.hidden = false;
			els.skel.hidden = true;
			els.plate.hidden = true;
			if (detail.message) els.errorMsg.textContent = detail.message;
			return;
		}
		els.error.hidden = true;
		if (state === 'loading') {
			els.skel.hidden = false;
			els.plate.hidden = true;
		} else {
			els.skel.hidden = true;
			els.plate.hidden = false;
		}
		if (detail.name) setName(detail.name);
		els.state.textContent = STATE_LABEL[state] || state;
		root.style.setProperty('--emb-dot', STATE_DOT[state] || '#5eead4');
		root.classList.toggle('emb__pulse', state === 'speaking' || state === 'thinking');

		// Emotion glyph while speaking.
		if (state === 'speaking' && detail.emotion && detail.emotion !== 'neutral') {
			els.emotion.hidden = false;
			els.emotion.textContent = `${EMOTION_GLYPH[detail.emotion] || '•'} ${detail.emotion}`;
		} else {
			els.emotion.hidden = true;
		}

		// One-time rig-fallback note when a non-canonical rig loads.
		if (state === 'idle' && detail.rig === 'fallback' && !els.note.dataset.shown) {
			els.note.hidden = false;
			els.note.textContent = 'Static rig — gentle idle (no skeletal animation on this model).';
			els.note.dataset.shown = '1';
			setTimeout(() => { els.note.hidden = true; }, 6000);
		}
	}

	/**
	 * Render the chain-state badge cluster from a mapChainStateToVisuals() result
	 * (apps-sdk/embodiment/chain-visuals.js) — the same object EmbodimentStage's
	 * setChainState() returns, so a caller drives both from one identity read.
	 * Pass `null` to hide the cluster (no wallet binding requested for this
	 * persona) — a designed absence, not an error state.
	 * @param {{aura:object, cosmetic:object, muted:boolean, nameplate:(string|null)}|null} visuals
	 */
	function setIdentity(visuals) {
		if (!visuals) {
			els.identity.hidden = true;
			return;
		}
		els.identity.hidden = false;
		root.style.setProperty('--emb-aura', visuals.aura.color);
		root.style.setProperty('--emb-cosmetic', visuals.cosmetic.color);
		els.idAura.title = `Reputation: ${visuals.aura.label}`;
		els.idBadge.textContent = `${visuals.cosmetic.glyph} ${visuals.cosmetic.label}`;
		if (visuals.nameplate) {
			els.idName.hidden = false;
			els.idName.textContent = visuals.nameplate;
		} else {
			els.idName.hidden = true;
		}
		els.idMuted.hidden = !visuals.muted;
		els.identity.classList.toggle('emb__identity--muted', !!visuals.muted);
	}

	function destroy() {
		root.remove();
	}

	return { setName, setState, setIdentity, destroy, el: root };
}
