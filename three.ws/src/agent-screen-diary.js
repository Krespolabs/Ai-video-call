// agent-screen-diary.js — the Agent Memory Diary panel for /agent-screen.
//
// At the end of its day the agent opens its real memory and reflects: it reads
// back the day's most salient memories and the people/coins/topics it keeps
// returning to, narrates a short first-person diary entry in its own TTS voice,
// and lights up a live memory graph node-by-node as it speaks. Nothing is
// invented — every word, node and chip originates from the agent's persistent
// memory (api/agent-reflect-digest → real agent_memories + the mined entity
// graph; the LLM only summarizes those rows).
//
// Self-contained on purpose (the agent-screen.js host is heavily co-edited):
//   • builds its own DOM into the panel body,
//   • owns its TTS + RMS lip-sync (driven through the shared Avatar Cam head via
//     getAvatar(); its tick() is installed into the webcam render loop),
//   • opens its own lightweight SSE client to refresh when a new high-salience
//     action lands, and
//   • coordinates with the Newsroom Anchor through pauseOtherNarration() so the
//     two never talk over each other.

import { AgentMemoryGraph } from './agent-memory-graph.js';
import { AvatarMouthTarget } from './voice/avatar-morph-target.js';
import { createAgentScreenClient } from './shared/agent-screen-client.js';

const DIARY_VOICE = 'nova';
const LS_MUTE_KEY = 'asc_diary_muted';
// Actions whose arrival is worth re-reading the diary for (high-signal).
const REFRESH_TYPES = new Set(['trade', 'analysis']);
const REFRESH_DEBOUNCE_MS = 8000;

// One shared AudioContext for the RMS analyser path — browsers cap live contexts.
let _audioCtx = null;
function audioContext() {
	if (!_audioCtx) {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (Ctx) _audioCtx = new Ctx();
	}
	return _audioCtx;
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function startOfDayMs() {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

const KIND_GLYPH = { mint: '◎', ticker: '◎', person: '☻', agent: '☻', wallet: '⬡', strategy: '✦', topic: '#' };

/**
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {HTMLElement} opts.body                 panel body to render into
 * @param {() => any} opts.getAvatar              returns the Avatar Cam root (or null)
 * @param {() => void} [opts.pauseOtherNarration] called before the diary speaks
 */
export function createDiaryPanel({ agentId, body, getAvatar, pauseOtherNarration }) {
	const mouthTarget = new AvatarMouthTarget();
	let boundAvatar = null;

	let muted = readMutePref();
	let digest = null;
	let graph = null;
	let state = 'idle'; // 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'locked'
	let loadedOnce = false;

	// Narration state.
	let audioEl = null;
	let analyser = null;
	let analyserData = null;
	let speaking = false;
	let speakToken = 0;
	let revealRaf = null;
	let revealStart = 0;
	const litEntities = new Set();

	let refreshTimer = null;
	let sse = null;

	// ── DOM ──────────────────────────────────────────────────────────────────
	body.classList.add('asc-diary-body');
	body.innerHTML = `
		<div class="asc-diary">
			<div class="asc-diary-tools">
				<button class="asc-diary-btn asc-diary-narrate" data-act="narrate" title="Narrate today's diary" disabled>
					<span class="asc-diary-narrate-ic">▶</span><span class="asc-diary-narrate-lbl">Narrate</span>
				</button>
				<button class="asc-diary-btn asc-diary-mute" data-act="mute" title="Mute narration" aria-pressed="false">🔊</button>
				<span class="asc-diary-when" id="asc-diary-when"></span>
				<button class="asc-diary-btn asc-diary-refresh" data-act="refresh" title="Refresh reflection" aria-label="Refresh">↻</button>
			</div>
			<div class="asc-diary-counts" id="asc-diary-counts" hidden></div>
			<p class="asc-diary-text" id="asc-diary-text" aria-live="polite"></p>
			<div class="asc-diary-graph-wrap">
				<canvas class="asc-diary-graph" id="asc-diary-graph"></canvas>
			</div>
			<div class="asc-diary-entities" id="asc-diary-entities"></div>
			<div class="asc-diary-overlay" id="asc-diary-overlay" hidden></div>
		</div>
	`;

	const els = {
		narrate: body.querySelector('[data-act="narrate"]'),
		mute: body.querySelector('[data-act="mute"]'),
		refresh: body.querySelector('[data-act="refresh"]'),
		when: body.querySelector('#asc-diary-when'),
		counts: body.querySelector('#asc-diary-counts'),
		text: body.querySelector('#asc-diary-text'),
		canvas: body.querySelector('#asc-diary-graph'),
		entities: body.querySelector('#asc-diary-entities'),
		overlay: body.querySelector('#asc-diary-overlay'),
	};

	graph = new AgentMemoryGraph(els.canvas, {
		onNodeClick: (node) => {
			const ent = (digest?.entities || []).find((e) => e.id === node.id);
			if (ent?.href) window.location.href = ent.href;
		},
	});

	// Self-trigger: load + (gesture-permitting) narrate the first time the panel
	// becomes visible, and keep the graph canvas sized to the panel. This keeps
	// the heavily co-edited host from having to wire toggle/resize callbacks.
	const panelRoot = body.closest('.asc-panel');
	let panelObserver = null;
	if (panelRoot) {
		panelObserver = new MutationObserver(() => {
			if (!panelRoot.hidden && !panelRoot.classList.contains('minimized')) onOpen();
		});
		panelObserver.observe(panelRoot, { attributes: true, attributeFilter: ['hidden', 'class'] });
	}
	let canvasObserver = null;
	if (typeof ResizeObserver !== 'undefined') {
		canvasObserver = new ResizeObserver(() => graph?.resize());
		canvasObserver.observe(els.canvas);
	}

	els.narrate.addEventListener('click', () => {
		if (speaking) stopNarration();
		else narrate({ userGesture: true });
	});
	els.mute.addEventListener('click', toggleMute);
	els.refresh.addEventListener('click', () => load({ force: true }));
	setMuteUi();

	// ── state rendering ────────────────────────────────────────────────────────
	function setOverlay(html) {
		if (!html) { els.overlay.hidden = true; els.overlay.innerHTML = ''; return; }
		els.overlay.hidden = false;
		els.overlay.innerHTML = html;
		const retry = els.overlay.querySelector('[data-act="retry"]');
		if (retry) retry.addEventListener('click', () => load({ force: true }));
	}

	function showLoading() {
		state = 'loading';
		els.narrate.disabled = true;
		els.counts.hidden = true;
		els.text.textContent = '';
		els.entities.innerHTML = '';
		setOverlay(`
			<div class="asc-diary-skel">
				<span class="asc-diary-skel-line"></span>
				<span class="asc-diary-skel-line"></span>
				<span class="asc-diary-skel-line short"></span>
			</div>
		`);
	}

	function showEmpty() {
		state = 'empty';
		els.narrate.disabled = true;
		els.counts.hidden = true;
		els.text.textContent = '';
		els.entities.innerHTML = '';
		// A single seed node so the graph isn't a void.
		graph.setData({ nodes: [{ id: 'seed', kind: 'topic', label: digest?.agentName || 'today', mentions: 1, salience: 0.5 }], edges: [] });
		graph.resize();
		setOverlay(`
			<div class="asc-diary-msg">
				<strong>No memories yet today.</strong>
				<span>Give this agent a task below and watch its diary fill in as it works and remembers.</span>
				<button class="asc-diary-link" data-act="focus-task">Give it a task ↓</button>
			</div>
		`);
		const focus = els.overlay.querySelector('[data-act="focus-task"]');
		if (focus) focus.addEventListener('click', () => document.getElementById('asc-task-input')?.focus());
	}

	function showError(msg, { locked = false } = {}) {
		state = locked ? 'locked' : 'error';
		els.narrate.disabled = true;
		els.counts.hidden = true;
		setOverlay(`
			<div class="asc-diary-msg">
				<strong>${esc(locked ? 'Owner only' : 'Couldn’t load today’s reflection')}</strong>
				<span>${esc(msg || 'Something went wrong reading the memory.')}</span>
				${locked ? '' : '<button class="asc-diary-link" data-act="retry">Retry</button>'}
			</div>
		`);
	}

	function renderCounts(counts) {
		const chips = [
			{ k: 'learned', label: 'learned', v: counts.learned },
			{ k: 'decided', label: 'decided', v: counts.decided },
			{ k: 'interacted', label: 'connected', v: counts.interacted },
		];
		els.counts.innerHTML = chips.map((c) => `
			<span class="asc-diary-count asc-diary-count--${c.k}">
				<span class="asc-diary-count-v">${c.v}</span>
				<span class="asc-diary-count-l">${c.label}</span>
			</span>
		`).join('');
		els.counts.hidden = false;
	}

	function renderEntities(entities) {
		if (!entities.length) { els.entities.innerHTML = ''; return; }
		els.entities.innerHTML = entities.map((e) => {
			const glyph = KIND_GLYPH[e.kind] || '#';
			const inner = `<span class="asc-diary-chip-ic">${glyph}</span><span class="asc-diary-chip-lbl">${esc(e.label)}</span><span class="asc-diary-chip-n">${e.mentions}</span>`;
			const title = `${esc(e.label)} — ${esc(e.kind)}, mentioned ${e.mentions}×`;
			if (e.href) {
				return `<a class="asc-diary-chip asc-diary-chip--link" href="${esc(e.href)}" data-eid="${esc(e.id)}" title="${title}">${inner}</a>`;
			}
			return `<span class="asc-diary-chip" data-eid="${esc(e.id)}" title="${title}">${inner}</span>`;
		}).join('');
		// Hovering a chip pulses its graph node.
		els.entities.querySelectorAll('[data-eid]').forEach((chip) => {
			chip.addEventListener('mouseenter', () => graph.light(chip.dataset.eid));
		});
	}

	function render(d) {
		digest = d;
		state = 'ready';
		setOverlay(null);
		const when = new Date(d.since);
		els.when.textContent = `since ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
		renderCounts(d.counts);
		renderEntities(d.entities);
		graph.setData({ nodes: graphNodes(d), edges: [] });
		graph.resize();
		graph.start();
		els.narrate.disabled = !d.diaryText;
		// Show the full text immediately (readable without audio); narration will
		// re-reveal it in step with the voice.
		els.text.textContent = d.diaryText || '';
	}

	// The digest returns shaped entities (id/kind/label/mentions); rebuild light
	// graph nodes from them. Edges aren't shipped in the digest, so co-occurrence
	// is implied by shared rendering — nodes still rank + glow by mentions.
	function graphNodes(d) {
		return (d.entities || []).map((e) => ({
			id: e.id, kind: e.kind, label: e.label, mentions: e.mentions, salience: e.salience,
		}));
	}

	// ── load ───────────────────────────────────────────────────────────────────
	let inflight = null;
	async function load({ force = false } = {}) {
		if (inflight && !force) return inflight;
		if (state === 'loading') return inflight;
		loadedOnce = true;
		showLoading();
		const since = startOfDayMs();
		inflight = (async () => {
			try {
				const r = await fetch(`/api/agent-reflect-digest?agentId=${encodeURIComponent(agentId)}&since=${since}`, {
					credentials: 'include',
				});
				if (r.status === 401) { showError('Sign in as this agent’s owner to read its diary.', { locked: true }); return; }
				if (r.status === 403) { showError('This diary belongs to another owner.', { locked: true }); return; }
				if (!r.ok) { showError(`Reflection failed (${r.status}).`); return; }
				const d = await r.json();
				if (!d || !d.highlights?.length) { showEmpty(); return; }
				render(d);
			} catch (err) {
				console.warn('[diary] load failed:', err?.message);
				showError('Check your connection and try again.');
			} finally {
				inflight = null;
			}
		})();
		return inflight;
	}

	// ── narration (TTS + RMS lip-sync through the Avatar Cam) ───────────────────
	function ensureAvatarBound() {
		const root = getAvatar?.();
		if (root && root !== boundAvatar) { boundAvatar = root; mouthTarget.attach(root); }
		return boundAvatar;
	}

	function stopNarration() {
		speakToken++;
		speaking = false;
		if (revealRaf) { cancelAnimationFrame(revealRaf); revealRaf = null; }
		if (audioEl) {
			try { audioEl.pause(); } catch { /* */ }
			if (audioEl.src?.startsWith('blob:')) { try { URL.revokeObjectURL(audioEl.src); } catch { /* */ } }
			audioEl = null;
		}
		analyser = null;
		analyserData = null;
		mouthTarget.setMouthShape({ open: 0 });
		setNarrateUi(false);
		els.text.classList.remove('is-typing');
		// Restore the full text in case a reveal was mid-flight.
		if (digest?.diaryText && els.text.textContent !== digest.diaryText) els.text.textContent = digest.diaryText;
	}

	async function narrate({ userGesture = false } = {}) {
		const text = digest?.diaryText;
		if (!text || state !== 'ready') return;
		stopNarration();
		if (muted && !userGesture) { return; } // silent typed reveal handled by render()
		pauseOtherNarration?.();
		const myToken = ++speakToken;
		litEntities.clear();
		setNarrateUi(true);
		speaking = true;

		// TTS → audio bytes; lip-sync from real RMS amplitude.
		let blob = null;
		try {
			const r = await fetch('/api/tts/speak', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, voice: DIARY_VOICE, format: 'mp3' }),
			});
			if (!r.ok) throw new Error(`tts ${r.status}`);
			blob = await r.blob();
		} catch {
			// No audio — fall back to a silent typed reveal so the panel never blocks.
			if (myToken !== speakToken) return;
			runReveal({ durationMs: Math.min(16000, Math.max(4000, text.length * 45)), audio: null });
			return;
		}
		if (myToken !== speakToken) return;

		audioEl = new Audio();
		audioEl.src = URL.createObjectURL(blob);
		audioEl.muted = false;
		const ctx = audioContext();
		if (ctx) {
			try {
				if (ctx.state === 'suspended') await ctx.resume();
				const src = ctx.createMediaElementSource(audioEl);
				analyser = ctx.createAnalyser();
				analyser.fftSize = 1024;
				analyser.smoothingTimeConstant = 0.5;
				src.connect(analyser);
				analyser.connect(ctx.destination);
				analyserData = new Uint8Array(analyser.fftSize);
			} catch { analyser = null; }
		}

		const onEnd = () => {
			if (myToken !== speakToken) return;
			speaking = false;
			if (revealRaf) { cancelAnimationFrame(revealRaf); revealRaf = null; }
			mouthTarget.setMouthShape({ open: 0 });
			setNarrateUi(false);
			els.text.textContent = text; // ensure fully shown
			els.text.classList.remove('is-typing');
		};
		audioEl.addEventListener('ended', onEnd, { once: true });
		audioEl.addEventListener('error', onEnd, { once: true });

		try {
			await audioEl.play();
		} catch {
			// Autoplay blocked — keep text visible, reset to a Play affordance.
			if (myToken === speakToken) { speaking = false; setNarrateUi(false); els.text.textContent = text; }
			return;
		}
		runReveal({ durationMs: null, audio: audioEl });
	}

	// Reveal the diary text in step with the voice (or a fixed cadence when
	// silent), lighting each entity's graph node as its name is spoken.
	function runReveal({ durationMs, audio }) {
		const text = digest?.diaryText || '';
		const lower = text.toLowerCase();
		const entities = digest?.entities || [];
		revealStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
		els.text.textContent = '';
		els.text.classList.add('is-typing');
		const step = () => {
			revealRaf = requestAnimationFrame(step);
			let progress;
			if (audio && audio.duration && isFinite(audio.duration)) {
				progress = audio.duration ? audio.currentTime / audio.duration : 1;
			} else {
				const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
				progress = durationMs ? (now - revealStart) / durationMs : 1;
			}
			progress = Math.max(0, Math.min(1, progress));
			const n = Math.floor(text.length * progress);
			const shown = text.slice(0, n);
			els.text.textContent = shown;
			// Light entities whose label has now been spoken.
			const shownLower = shown.toLowerCase();
			for (const e of entities) {
				if (litEntities.has(e.id)) continue;
				if (e.label && shownLower.includes(e.label.toLowerCase())) {
					litEntities.add(e.id);
					graph.light(e.id);
				}
			}
			if (progress >= 1 && !audio) {
				cancelAnimationFrame(revealRaf); revealRaf = null;
				els.text.textContent = text;
				els.text.classList.remove('is-typing');
			}
		};
		revealRaf = requestAnimationFrame(step);
	}

	function setNarrateUi(on) {
		els.narrate.classList.toggle('asc-diary-narrate--on', on);
		const ic = els.narrate.querySelector('.asc-diary-narrate-ic');
		const lbl = els.narrate.querySelector('.asc-diary-narrate-lbl');
		if (ic) ic.textContent = on ? '⏹' : '▶';
		if (lbl) lbl.textContent = on ? 'Stop' : 'Narrate';
	}

	// Driven from the webcam render loop (installed as lipsyncSampler).
	function tick() {
		if (!speaking || !analyser || !analyserData) return;
		ensureAvatarBound();
		analyser.getByteTimeDomainData(analyserData);
		let sum = 0;
		for (let i = 0; i < analyserData.length; i++) {
			const v = (analyserData[i] - 128) / 128;
			sum += v * v;
		}
		const rms = Math.sqrt(sum / analyserData.length);
		mouthTarget.setMouthShape({ open: Math.min(1, rms * 3.2) });
	}

	// ── mute ─────────────────────────────────────────────────────────────────
	function readMutePref() {
		try { const v = localStorage.getItem(LS_MUTE_KEY); return v === '1'; } catch { return false; }
	}
	function setMuteUi() {
		els.mute.classList.toggle('asc-muted', muted);
		els.mute.setAttribute('aria-pressed', String(!muted));
		els.mute.title = muted ? 'Unmute narration' : 'Mute narration';
		els.mute.textContent = muted ? '🔇' : '🔊';
	}
	function toggleMute() {
		muted = !muted;
		try { localStorage.setItem(LS_MUTE_KEY, muted ? '1' : '0'); } catch { /* quota */ }
		setMuteUi();
		if (muted && speaking) stopNarration();
	}

	// ── refresh on new high-salience activity (own SSE) ────────────────────────
	function startStream() {
		if (sse) return;
		sse = createAgentScreenClient(agentId, {
			onFrame(frame) {
				if (!frame || !REFRESH_TYPES.has(frame.type)) return;
				scheduleRefresh();
			},
		});
		sse.connect();
	}
	function scheduleRefresh() {
		if (state !== 'ready' && state !== 'empty') return;
		if (speaking) return; // don't yank text out from under a live narration
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => load({ force: true }), REFRESH_DEBOUNCE_MS);
	}

	// ── public surface ─────────────────────────────────────────────────────────
	// Called when the panel becomes visible (first open or un-hide).
	function onOpen() {
		if (graph) { graph.resize(); graph.start(); }
		if (!loadedOnce) {
			load().then(() => {
				startStream();
				// A user opening the panel is a real gesture → narrate once, unless muted.
				if (state === 'ready' && !muted) narrate({ userGesture: true });
			});
		}
	}

	function onResize() { graph?.resize(); }

	// Optional external nudge (host may forward frames); the own SSE covers the
	// default path, so this is purely additive.
	function notifyActivity(frame) {
		if (frame && REFRESH_TYPES.has(frame.type)) scheduleRefresh();
	}

	function destroy() {
		stopNarration();
		clearTimeout(refreshTimer);
		try { sse?.disconnect(); } catch { /* */ }
		try { panelObserver?.disconnect(); } catch { /* */ }
		try { canvasObserver?.disconnect(); } catch { /* */ }
		graph?.dispose();
		mouthTarget.dispose();
	}

	return { tick, onOpen, onResize, refresh: () => load({ force: true }), notifyActivity, destroy };
}
