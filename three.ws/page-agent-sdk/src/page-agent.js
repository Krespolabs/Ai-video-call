/**
 * PageAgent — @three-ws/page-agent
 * ================================
 *
 * The product surface: a floating, rigged 3D agent docked in the corner of any
 * page that talks the visitor through it. Composes the three building blocks —
 * AvatarStage (renders + animates the rigged GLB), SpeechNarrator (TTS +
 * lipsync), AvatarPicker (visitor chooses their guide) — into one drop-in
 * controller, plus a control bar, caption bubble, drag-to-move, and an
 * auto-narration walk over the page's content.
 *
 * Public API (also surfaced on the <page-agent> element):
 *   agent.narrate(text, { interrupt })   → Promise<void>
 *   agent.narratePage({ selector })       → Promise<void>   (sequential walk)
 *   agent.stop()                          → cancel narration
 *   agent.setAgent(id)                    → swap rigged avatar live
 *   agent.openPicker() / closePicker()
 *   agent.mute(bool) / collapse(bool)
 *   agent.on(event, cb) / off(event, cb)  events: ready, agentchange, state,
 *                                          caption, segment, error
 */

import { AGENTS, DEFAULT_AGENT_ID, DEFAULT_ASSET_BASE, getAgent, agentUrl, filterAgents } from './catalog.js';
import { AvatarStage } from './stage.js';
import { SpeechNarrator } from './narrator.js';
import { AvatarPicker } from './picker.js';
import { injectStyles } from './styles.js';
import { resolvePersonaConfig, sanitizeContext, buildSystemPrompt } from './presets.js';

const ICONS = {
	play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
	stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
	mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
	unmute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
	swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="m17 3 3 2-3 2"/></svg>',
	min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
};

const EVENTS = ['ready', 'agentchange', 'state', 'caption', 'segment', 'error'];

export class PageAgent {
	/**
	 * @param {{
	 *   mount?: HTMLElement, agent?: string, agents?: string[], assetBase?: string,
	 *   position?: 'bottom-right'|'bottom-left'|'top-right'|'top-left',
	 *   muted?: boolean, collapsed?: boolean, picker?: boolean, controls?: boolean,
	 *   greeting?: string, autoNarrate?: boolean|string, persistAgent?: boolean,
	 *   preset?: string, context?: Record<string, unknown>,
	 *   suggestedPrompts?: (string|{prompt:string, response?:string, action?:'narrate'|'tour'})[],
	 *   tools?: string[]
	 * }} [config]
	 *
	 * `preset` resolves a persona (greeting, systemRole, suggestedPrompts, tools) —
	 * see `src/presets.js`. Explicit `greeting` / `suggestedPrompts` / `tools`
	 * always win over the preset's defaults. `context` is sanitized host state
	 * folded into `systemPrompt` (see `presets.js#buildSystemPrompt`) — this
	 * package never sends it anywhere itself.
	 */
	constructor(config = {}) {
		if (typeof window === 'undefined') throw new Error('[page-agent] requires a browser environment');
		this.config = config;
		this.assetBase = config.assetBase || DEFAULT_ASSET_BASE;
		this.roster = config.agents?.length ? filterAgents({ ids: config.agents }) : AGENTS;
		if (!this.roster.length) this.roster = AGENTS;

		this._listeners = new Map(EVENTS.map((e) => [e, new Set()]));
		this._agent = null;
		this._narrationToken = 0;

		// ── Persona preset resolution (explicit config always wins) ────────────
		const persona = resolvePersonaConfig(config);
		this._preset = persona.preset;
		this._context = persona.context;
		this.tools = persona.tools;
		this.suggestedPrompts = persona.suggestedPrompts;
		this._effectiveGreeting = persona.greeting;

		injectStyles();
		this._buildDom();
		this._renderPrompts();

		this.stage = new AvatarStage(this._stageEl, { background: 'transparent' });
		this.narrator = new SpeechNarrator(this.stage, {
			muted: !!config.muted,
			onState: (s) => { this._root.dataset.state = s === 'speaking' ? 'speaking' : this._stateBase(); this._reflectPlay(); this._emit('state', s); },
			onCaption: (c) => { this._setCaption(c); this._emit('caption', c); },
			onError: (e) => this._emit('error', e),
		});

		if (config.picker !== false) {
			this.picker = new AvatarPicker(this.roster, {
				onSelect: (id) => this.setAgent(id),
				getCurrent: () => this._agent?.id,
			});
		}

		// Initial agent: explicit > persisted (if enabled) > default > first roster.
		const persisted = config.persistAgent !== false ? AvatarPicker.restore() : null;
		const initial = config.agent || persisted || DEFAULT_AGENT_ID;
		const startId = this.roster.find((a) => a.id === initial) ? initial : this.roster[0].id;

		this._muted = !!config.muted;
		this._collapsed = !!config.collapsed;
		this._root.dataset.state = this._stateBase();
		// Reflect the starting mute state onto the button (icon + aria-pressed),
		// so a `muted: true` config doesn't render an out-of-sync "unmuted" control.
		this.mute(this._muted);

		this.setAgent(startId).then(() => {
			this._emit('ready', this._agent);
			if (config.autoNarrate) {
				const sel = typeof config.autoNarrate === 'string' ? config.autoNarrate : undefined;
				this.narratePage({ selector: sel, greet: true });
			} else if (this._effectiveGreeting) {
				this.narrate(this._effectiveGreeting);
			}
		}).catch((e) => this._emit('error', e));
	}

	// ── DOM ──────────────────────────────────────────────────────────────────

	_buildDom() {
		const root = document.createElement('div');
		root.className = 'tw-pa-root';
		root.dataset.pos = this.config.position || 'bottom-right';

		// Launcher (collapsed state)
		const launcher = document.createElement('button');
		launcher.className = 'tw-pa-launcher';
		launcher.type = 'button';
		launcher.innerHTML = `<span class="tw-pa-orb" aria-hidden="true"></span><span class="tw-pa-launch-label">Ask a guide</span>`;
		launcher.setAttribute('aria-label', 'Open the 3D guide');
		launcher.addEventListener('click', () => this.collapse(false));

		const dock = document.createElement('div');
		dock.className = 'tw-pa-dock';

		const stage = document.createElement('div');
		stage.className = 'tw-pa-stage';

		const name = document.createElement('div');
		name.className = 'tw-pa-name';
		name.innerHTML = '<span class="tw-pa-name-text">Agent</span>';

		const caption = document.createElement('div');
		caption.className = 'tw-pa-caption';
		caption.setAttribute('aria-live', 'polite');
		caption.dataset.show = 'false';

		stage.append(name, caption);
		this._enableDrag(root, stage);

		// Suggested-prompt chips (from a persona preset, or explicit config)
		const prompts = document.createElement('div');
		prompts.className = 'tw-pa-prompts';
		prompts.setAttribute('role', 'group');
		prompts.setAttribute('aria-label', 'Suggested prompts');
		prompts.hidden = true;

		// Control bar
		const bar = document.createElement('div');
		bar.className = 'tw-pa-bar';
		if (this.config.controls === false) bar.style.display = 'none';

		this._playBtn = mkBtn(ICONS.play, 'Play narration', () => this._togglePlay());
		this._muteBtn = mkBtn(ICONS.unmute, 'Mute', () => this.mute(!this._muted));
		this._swapBtn = mkBtn(ICONS.swap, 'Change agent', () => this.openPicker());
		if (this.config.picker === false) this._swapBtn.style.display = 'none';
		const spacer = document.createElement('div');
		spacer.className = 'tw-pa-spacer';
		this._minBtn = mkBtn(ICONS.min, 'Minimize', () => this.collapse(true));

		bar.append(this._playBtn, this._muteBtn, this._swapBtn, spacer, this._minBtn);

		dock.append(stage, prompts, bar);
		root.append(dock, launcher);
		document.body.appendChild(root);

		this._root = root;
		this._stageEl = stage;
		this._nameEl = name.querySelector('.tw-pa-name-text');
		this._captionEl = caption;
		this._launcher = launcher;
		this._promptsEl = prompts;
	}

	/** Render/refresh the suggested-prompt chip row from `this.suggestedPrompts`. */
	_renderPrompts() {
		const el = this._promptsEl;
		if (!el) return;
		el.innerHTML = '';
		if (!this.suggestedPrompts.length) {
			el.hidden = true;
			return;
		}
		el.hidden = false;
		for (const item of this.suggestedPrompts) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'tw-pa-prompt';
			btn.textContent = item.prompt;
			btn.addEventListener('click', () => {
				if (item.action === 'tour') this.narratePage({ greet: false });
				else this.narrate(item.response, { interrupt: true });
			});
			el.appendChild(btn);
		}
	}

	_enableDrag(root, handle) {
		let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
		const down = (e) => {
			if (e.target.closest('.tw-pa-caption')) return;
			const p = pointer(e);
			dragging = true; moved = false;
			sx = p.x; sy = p.y;
			const r = root.getBoundingClientRect();
			ox = r.left; oy = r.top;
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
		};
		const move = (e) => {
			if (!dragging) return;
			const p = pointer(e);
			const dx = p.x - sx, dy = p.y - sy;
			if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
			root.dataset.pos = '';
			root.style.left = clamp(ox + dx, 4, window.innerWidth - root.offsetWidth - 4) + 'px';
			root.style.top = clamp(oy + dy, 4, window.innerHeight - root.offsetHeight - 4) + 'px';
			root.style.right = 'auto';
			root.style.bottom = 'auto';
		};
		const up = () => {
			dragging = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		handle.addEventListener('pointerdown', down);
		// Let dispose() unbind the handle and any drag still in flight.
		this._teardownDrag = () => {
			handle.removeEventListener('pointerdown', down);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
	}

	// ── Agent lifecycle ────────────────────────────────────────────────────────

	/** Swap to a rigged agent by id. Loads its GLB and reframes. */
	async setAgent(id) {
		const agent = getAgent(id) || this.roster[0];
		if (!agent) return;
		this._agent = agent;
		this.narrator.setAgent(agent);
		this._nameEl.textContent = agent.name;
		this._root.style.setProperty('--tw-pa-accent', agent.accent);
		this._launcher.querySelector('.tw-pa-launch-label').textContent = `Ask ${agent.name}`;
		try {
			await this.stage.load(agentUrl(agent, this.assetBase), { framing: agent.framing });
			this._emit('agentchange', agent);
		} catch (e) {
			this._emit('error', new Error(`Failed to load agent "${agent.id}": ${e.message}`));
			throw e;
		}
	}

	// ── Narration ───────────────────────────────────────────────────────────────

	/** Speak a single line. @returns {Promise<void>} */
	narrate(text, opts = {}) {
		if (this._collapsed) this.collapse(false);
		return this.narrator.speak(text, opts);
	}

	/**
	 * Walk the page and narrate it segment by segment. Pulls text from, in order
	 * of preference: elements matching `selector`, then `[data-narrate]`, then a
	 * sensible heading/paragraph fallback. Highlights the current segment.
	 * @param {{ selector?: string, greet?: boolean }} [opts]
	 * @returns {Promise<void>}
	 */
	async narratePage(opts = {}) {
		const token = ++this._narrationToken;
		this.stop(); // clear any prior walk but keep our token
		this._narrationToken = token;
		if (this._collapsed) this.collapse(false);

		const segments = collectSegments(opts.selector);
		if (opts.greet && this._agent) {
			await this.narrator.speak(this._agent.persona);
			if (token !== this._narrationToken) return;
		}
		if (!segments.length) {
			await this.narrator.speak("There's not much text on this page for me to read, but I'm here if you need a hand.");
			return;
		}
		for (const seg of segments) {
			if (token !== this._narrationToken) return;
			this._highlight(seg.el, true);
			this._emit('segment', { text: seg.text, el: seg.el });
			try { seg.el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); } catch { /* detached */ }
			await this.narrator.speak(seg.text);
			this._highlight(seg.el, false);
		}
	}

	/** Cancel any narration / walk in progress. */
	stop() {
		this._narrationToken++;
		this.narrator.cancel();
		this._clearHighlights();
	}

	_togglePlay() {
		if (this.narrator.speaking) this.stop();
		else this.narratePage({ selector: typeof this.config.autoNarrate === 'string' ? this.config.autoNarrate : undefined });
	}

	_reflectPlay() {
		const speaking = this.narrator.speaking;
		this._playBtn.innerHTML = speaking ? ICONS.stop : ICONS.play;
		this._playBtn.setAttribute('aria-label', speaking ? 'Stop narration' : 'Play narration');
	}

	// ── Controls ────────────────────────────────────────────────────────────────

	mute(on) {
		this._muted = !!on;
		this.narrator.setMuted(this._muted);
		this._muteBtn.innerHTML = this._muted ? ICONS.mute : ICONS.unmute;
		this._muteBtn.setAttribute('aria-pressed', String(this._muted));
		this._muteBtn.setAttribute('aria-label', this._muted ? 'Unmute' : 'Mute');
	}

	collapse(on) {
		this._collapsed = !!on;
		this._root.dataset.state = this._stateBase();
		if (this._collapsed) this.stop();
	}

	openPicker() {
		this.picker?.open();
	}

	closePicker() {
		this.picker?.close();
	}

	// ── Events ──────────────────────────────────────────────────────────────────

	on(event, cb) { this._listeners.get(event)?.add(cb); return this; }
	off(event, cb) { this._listeners.get(event)?.delete(cb); return this; }
	_emit(event, payload) {
		for (const cb of this._listeners.get(event) || []) {
			try { cb(payload); } catch (e) { console.error('[page-agent] listener error', e); }
		}
	}

	get currentAgent() { return this._agent; }

	/** The resolved persona preset (`undefined` if no `preset` was set/unknown). */
	get currentPreset() { return this._preset; }

	/** Sanitized host context (read-only copy) — see `presets.js#sanitizeContext`. */
	get context() { return { ...this._context }; }

	/**
	 * `preset.systemRole` + sanitized `context`, composed into one plain-text
	 * brief (see `presets.js#buildSystemPrompt`). `page-agent` never sends this
	 * anywhere — it's for a host page (or a paired `<agent-3d chat>` on the same
	 * page) to hand to a real LLM.
	 */
	get systemPrompt() { return buildSystemPrompt(this._preset, this._context); }

	/** Update host context after load (e.g. once a wallet connects). Re-sanitized. */
	setContext(context) { this._context = sanitizeContext(context); }

	// ── Internals ─────────────────────────────────────────────────────────────────

	_stateBase() { return this._collapsed ? 'collapsed' : 'idle'; }

	_setCaption(text) {
		if (!text) { this._captionEl.dataset.show = 'false'; return; }
		this._captionEl.textContent = text;
		this._captionEl.dataset.show = 'true';
	}

	_highlight(el, on) {
		if (!el) return;
		if (on) {
			el.dataset._twPaPrevOutline = el.style.outline || '';
			el.style.outline = `2px solid ${this._agent?.accent || '#6366f1'}`;
			el.style.outlineOffset = '3px';
			el.style.borderRadius = el.style.borderRadius || '6px';
			this._highlighted = el;
		} else {
			el.style.outline = el.dataset._twPaPrevOutline || '';
			delete el.dataset._twPaPrevOutline;
			if (this._highlighted === el) this._highlighted = null;
		}
	}

	_clearHighlights() {
		if (this._highlighted) this._highlight(this._highlighted, false);
	}

	dispose() {
		this.stop();
		this._teardownDrag?.();
		this.narrator?.dispose();
		this.stage?.dispose();
		this.picker?.dispose();
		this._root?.remove();
	}
}

// ── Page content extraction ──────────────────────────────────────────────────

/**
 * Build an ordered list of narration segments from the live DOM.
 * Priority: explicit selector → [data-narrate] → heading/lead fallback.
 * @param {string} [selector]
 * @returns {{ el: Element, text: string }[]}
 */
export function collectSegments(selector) {
	const pick = (els) => Array.from(els)
		.map((el) => ({ el, text: narrationText(el) }))
		.filter((s) => s.text.length > 1);

	if (selector) {
		const found = pick(document.querySelectorAll(selector));
		if (found.length) return found;
	}
	const tagged = pick(document.querySelectorAll('[data-narrate]'));
	if (tagged.length) {
		// Honor explicit ordering via data-narrate-order when present.
		return tagged.sort((a, b) => order(a.el) - order(b.el));
	}
	// Fallback: headings + their following lead paragraph, in document order.
	const out = [];
	const heads = document.querySelectorAll('main h1, main h2, main h3, article h1, article h2, article h3, h1, h2');
	const seen = new Set();
	for (const h of heads) {
		if (seen.has(h) || !isVisible(h)) continue;
		seen.add(h);
		let text = narrationText(h);
		const lead = nextParagraph(h);
		if (lead && !seen.has(lead)) { seen.add(lead); text += '. ' + narrationText(lead); }
		if (text.length > 1) out.push({ el: h, text });
		if (out.length >= 12) break; // keep a page tour reasonable
	}
	return out;
}

function narrationText(el) {
	const explicit = el.getAttribute?.('data-narrate');
	if (explicit && explicit.trim()) return explicit.trim();
	return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function order(el) {
	const v = parseInt(el.getAttribute('data-narrate-order') || '', 10);
	return Number.isFinite(v) ? v : 1e6;
}

function nextParagraph(h) {
	let n = h.nextElementSibling;
	let hops = 0;
	while (n && hops < 4) {
		if (n.tagName === 'P' && isVisible(n)) return n;
		if (/^H[1-6]$/.test(n.tagName)) return null;
		n = n.nextElementSibling; hops++;
	}
	return null;
}

function isVisible(el) {
	if (!el || !el.getClientRects().length) return false;
	const s = getComputedStyle(el);
	return s.visibility !== 'hidden' && s.display !== 'none';
}

// ── tiny helpers ──────────────────────────────────────────────────────────────

function mkBtn(svg, label, onClick) {
	const b = document.createElement('button');
	b.className = 'tw-pa-btn';
	b.type = 'button';
	b.innerHTML = svg;
	b.setAttribute('aria-label', label);
	b.addEventListener('click', onClick);
	return b;
}

function pointer(e) {
	return { x: e.clientX ?? e.touches?.[0]?.clientX ?? 0, y: e.clientY ?? e.touches?.[0]?.clientY ?? 0 };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
