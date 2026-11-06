// walk-gestures.js — the /walk avatar's gesture / emote system.
//
// Eight expressive gestures (wave, dance, sit, point, cheer, agree, disagree,
// talking) the player triggers from a radial wheel (hold `G` on desktop,
// long-press the action button on mobile), the quick keys 1–8, or
// programmatically via `window.walk.playGesture(name)` — the hook the narrator,
// chat, and TTS use.
//
// Gestures are driven through the existing AnimationStateMachine's gesture slot
// (see src/animation-state-machine.js) so the base locomotion graph never has
// to know about emotes. Two composition modes:
//
//   layer:'upper'  → an ADDITIVE upper-body overlay (AnimationManager.playOverlay)
//                    that adds on top of the live idle/walk/run clip. The avatar
//                    waves, points, or cheers while its legs keep walking.
//   layer:'full'   → a whole-body clip (sit, dance) that takes over the base
//                    layer. Locomotion is suppressed until the gesture ends; a
//                    movement input rises the avatar out of `sit`.
//
// No clip is ever hard-cut — every transition crossfades — so the avatar never
// flashes a bind/T-pose between gestures.

import { AnimationStateMachine, GESTURES, GESTURE_NAMES } from './animation-state-machine.js';
import { log } from './shared/log.js';

// Display order around the wheel (the ring lays out any count evenly) and for
// the quick keys / quick tray — only the first eight get quick keys 1–8; the
// rest are reachable from the wheel and window.walk.playGesture(name).
export const GESTURE_ORDER = Object.freeze([
	'wave', 'dance', 'sit', 'point', 'cheer', 'agree', 'disagree', 'talking',
	'nod', 'shrug', 'jog', 'celebrate',
]);

// Long-press threshold (ms) before the touch action button opens the wheel.
const LONG_PRESS_MS = 320;
// Loop-gesture safety cap (ms) — a held dance/talking auto-clears after this if
// nothing else stops it, so a forgotten loop never strands the avatar.
const LOOP_SAFETY_MS = 30_000;

/**
 * @typedef {Object} WalkGesturesOptions
 * @property {import('./animation-manager.js').AnimationManager} animationManager
 * @property {() => string} getMotionClip   Returns the base clip the avatar should settle back to (idle/walk/run).
 * @property {(clip: string) => void} [broadcast]  Replicate a gesture's clip to other players (net).
 * @property {(defs: Array) => void} [registerDefs]  Register the gesture clip defs with the host (manifest/manager).
 * @property {{ buzz?: (ms:number)=>void }} [haptics]
 * @property {HTMLElement} [host]            Element to mount the wheel into (defaults to document.body).
 */

export class WalkGestures {
	/** @param {WalkGesturesOptions} opts */
	constructor(opts) {
		this.animationManager = opts.animationManager;
		this.getMotionClip = typeof opts.getMotionClip === 'function' ? opts.getMotionClip : () => 'idle';
		this._broadcast = typeof opts.broadcast === 'function' ? opts.broadcast : null;
		this._haptics = opts.haptics || null;
		this._host = opts.host || document.body;

		// The gesture slot lives in a state machine instance so playback is driven
		// by transitions, not ad-hoc calls — onGesture renders each change.
		this.machine = new AnimationStateMachine({}, null, (p) => this._render(p));

		// What's currently rendered, so we can tear it down cleanly on replace/end.
		this._rendered = null; // { layer, gesture }
		this._loopSafetyTimer = null;

		// Wheel UI state.
		this._wheelEl = null;
		this._segments = [];
		this._wheelOpen = false;
		this._wheelMode = null; // 'hold' | 'sticky'
		this._highlight = -1;
		this._trayEl = null;
		this._destroyed = false;

		// Register clip defs so the manager can lazily load each gesture's clip.
		if (typeof opts.registerDefs === 'function') {
			opts.registerDefs(this.gestureDefs());
		}
	}

	// ── Definitions ──────────────────────────────────────────────────────────

	/** Animation defs (one per distinct clip) the host must register so they load. */
	gestureDefs() {
		const seen = new Set();
		const defs = [];
		for (const name of GESTURE_NAMES) {
			const g = GESTURES[name];
			if (seen.has(g.clip)) continue;
			seen.add(g.clip);
			defs.push({
				name: g.clip,
				url: `/animations/clips/${g.clip}.json`,
				label: g.label,
				icon: g.icon,
				loop: !!g.loop,
			});
		}
		return defs;
	}

	/** Ordered list of {name, ...def} for UI. */
	list() {
		return GESTURE_ORDER.filter((n) => GESTURES[n]).map((n) => ({ name: n, ...GESTURES[n] }));
	}

	isFullBodyActive() {
		return this._rendered?.layer === 'full';
	}

	getActive() {
		return this.machine.getGesture();
	}

	// ── Public playback API ──────────────────────────────────────────────────

	/**
	 * Play a gesture by name. Returns true if it was accepted (valid name).
	 * Re-playing the active loop gesture toggles it off (so a second `dance`
	 * press stops dancing).
	 * @param {string} name
	 * @param {{ silent?: boolean }} [opts]  silent: don't broadcast/emit (used for remote echoes)
	 */
	play(name, { silent = false } = {}) {
		const def = GESTURES[name];
		if (!def) {
			log.warn(`[WalkGestures] unknown gesture "${name}"`);
			return false;
		}
		// Toggle a held loop off if it's pressed again.
		if (def.loop && this.machine.getGesture() === name) {
			this.stop();
			return true;
		}
		const started = this.machine.playGesture(name);
		if (!started) return false;
		this._haptics?.buzz?.(6);
		if (!silent) {
			this._broadcast?.(def.clip);
			this._emit({ gesture: name, action: 'start', layer: def.layer, loop: !!def.loop });
		}
		return true;
	}

	/** Stop the active gesture and return to the base layer. */
	stop({ silent = false } = {}) {
		const prev = this.machine.endGesture();
		if (prev && !silent) this._emit({ gesture: prev, action: 'end' });
		return prev;
	}

	/**
	 * Toggle the looping `talking` overlay — wired to chat/TTS so the avatar reads
	 * as speaking while narration plays.
	 * @param {boolean} on
	 */
	setTalking(on) {
		if (on) {
			if (this.machine.getGesture() !== 'talking') this.play('talking');
		} else if (this.machine.getGesture() === 'talking') {
			this.stop();
		}
	}

	/**
	 * Called by the host whenever a movement input is read. A full-body gesture
	 * the avatar can't move out of (sit) — or any whole-body takeover — is cleared
	 * so locomotion resumes immediately.
	 */
	notifyMovement() {
		const g = this.machine.getGesture();
		if (!g) return;
		const def = GESTURES[g];
		if (def && def.layer === 'full') this.stop();
	}

	// ── Rendering (onGesture handler) ────────────────────────────────────────

	_render({ active, def }) {
		clearTimeout(this._loopSafetyTimer);
		this._loopSafetyTimer = null;

		if (!active) {
			this._teardownRendered('none');
			this._syncTray();
			return;
		}

		const nextLayer = def.layer;
		this._teardownRendered(nextLayer);

		if (nextLayer === 'upper') {
			this._rendered = { layer: 'upper', gesture: def.name };
			this.animationManager.playOverlay(def.clip, {
				loop: !!def.loop,
				crossfade: def.crossfade,
				upperBodyOnly: true,
				onFinished: () => {
					// One-shot overlay ended on its own — clear the slot (guarding
					// against the user having already triggered something else).
					if (this.machine.getGesture() === def.name) this.machine.endGesture();
				},
			}).then((ok) => {
				if (!ok && this.machine.getGesture() === def.name) {
					// Clip can't drive this rig — don't leave a phantom gesture active.
					this.machine.endGesture();
				}
			});
		} else {
			// Full-body takeover: crossfade the base layer to the gesture clip and
			// suppress locomotion until it ends.
			this._rendered = { layer: 'full', gesture: def.name };
			this.animationManager.crossfadeTo(def.clip, def.crossfade);
		}

		if (def.loop) {
			this._loopSafetyTimer = setTimeout(() => {
				if (this.machine.getGesture() === def.name) this.stop();
			}, LOOP_SAFETY_MS);
		}
		this._syncTray();
	}

	/**
	 * Stop whatever overlay/full clip is currently shown. When the next gesture is
	 * also full-body we leave the base layer for the incoming crossfade to claim;
	 * otherwise we settle the base back to locomotion.
	 * @param {'upper'|'full'|'none'} nextLayer
	 */
	_teardownRendered(nextLayer) {
		const r = this._rendered;
		this._rendered = null;
		if (!r) return;
		if (r.layer === 'upper') {
			this.animationManager.stopOverlay({ crossfade: 0.18 });
		} else if (r.layer === 'full' && nextLayer !== 'full') {
			// Leaving a full-body gesture for the base layer or an upper overlay —
			// crossfade the body back to the current locomotion clip.
			this.animationManager.crossfadeTo(this.getMotionClip(), 0.25);
		}
	}

	// ── Embed / event emission ───────────────────────────────────────────────

	_emit(detail) {
		const payload = { type: 'walk:gestured', ...detail };
		try {
			if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
				window.parent.postMessage(payload, '*');
			}
		} catch { /* cross-origin parent — ignore */ }
		try {
			window.dispatchEvent(new CustomEvent('walk:gesture', { detail }));
		} catch { /* no DOM (tests) */ }
	}

	// ── Wheel UI ─────────────────────────────────────────────────────────────

	_buildWheel() {
		if (this._wheelEl) return;
		const el = document.createElement('div');
		el.id = 'walk-gesture-palette'; // reuse id so zen-mode CSS hides it too
		el.className = 'walk-gesture-wheel';
		el.setAttribute('role', 'menu');
		el.setAttribute('aria-label', 'Gesture wheel');
		el.setAttribute('aria-hidden', 'true');

		const items = this.list();
		const count = items.length;
		const ring = document.createElement('div');
		ring.className = 'wheel-ring';
		this._segments = items.map((g, i) => {
			const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'wheel-seg';
			btn.dataset.gesture = g.name;
			btn.dataset.index = String(i);
			btn.setAttribute('role', 'menuitem');
			btn.setAttribute('aria-label', `${g.label} (${i + 1})`);
			btn.title = `${g.label} [${i + 1}]`;
			btn.style.setProperty('--x', `${Math.cos(angle) * 92}px`);
			btn.style.setProperty('--y', `${Math.sin(angle) * 92}px`);
			btn.innerHTML = `<span class="wheel-ico">${g.icon}</span><span class="wheel-lbl">${g.label}</span>`;
			btn.addEventListener('click', () => { this.play(g.name); this.closeWheel(); });
			btn.addEventListener('pointerenter', () => this._setHighlight(i));
			ring.appendChild(btn);
			return btn;
		});
		el.appendChild(ring);

		const hub = document.createElement('div');
		hub.className = 'wheel-hub';
		hub.textContent = 'Gestures';
		el.appendChild(hub);
		this._hubEl = hub;

		// Click on the backdrop closes.
		el.addEventListener('click', (e) => { if (e.target === el) this.closeWheel(); });

		this._host.appendChild(el);
		this._wheelEl = el;
	}

	_setHighlight(index) {
		this._highlight = index;
		this._segments.forEach((b, i) => b.classList.toggle('is-active', i === index));
		if (this._hubEl) {
			const g = index >= 0 ? this.list()[index] : null;
			this._hubEl.textContent = g ? g.label : 'Gestures';
		}
	}

	/** Highlight the segment nearest a screen point (wheel-relative angle). */
	_highlightFromPoint(clientX, clientY) {
		if (!this._wheelEl) return;
		const r = this._wheelEl.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = r.top + r.height / 2;
		const dx = clientX - cx;
		const dy = clientY - cy;
		const dist = Math.hypot(dx, dy);
		if (dist < 34) { this._setHighlight(-1); return; } // dead zone → cancel
		const count = this._segments.length;
		// Segment angles start at -90° (top). Map pointer angle to nearest slot.
		let a = Math.atan2(dy, dx) + Math.PI / 2;
		a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
		const idx = Math.round(a / (Math.PI * 2) * count) % count;
		this._setHighlight(idx);
	}

	isWheelOpen() { return this._wheelOpen; }

	/** @param {'hold'|'sticky'} mode */
	openWheel(mode = 'sticky') {
		this._buildWheel();
		this._wheelOpen = true;
		this._wheelMode = mode;
		this._setHighlight(-1);
		this._wheelEl.classList.add('is-open');
		this._wheelEl.setAttribute('aria-hidden', 'false');
		this._haptics?.buzz?.(5);
	}

	/** Close the wheel without selecting. */
	closeWheel() {
		if (!this._wheelOpen) return;
		this._wheelOpen = false;
		this._wheelMode = null;
		this._setHighlight(-1);
		if (this._wheelEl) {
			this._wheelEl.classList.remove('is-open');
			this._wheelEl.setAttribute('aria-hidden', 'true');
		}
	}

	/** Commit the highlighted segment (if any) and close. Used on G-release / pointer-up. */
	commitWheel() {
		if (!this._wheelOpen) return;
		const idx = this._highlight;
		this.closeWheel();
		if (idx >= 0) {
			const g = this.list()[idx];
			if (g) this.play(g.name);
		}
	}

	// ── Desktop: hold-G ──────────────────────────────────────────────────────

	/** keydown handler for `G` (call with the keydown's repeat flag). */
	wheelKeyDown(repeat) {
		if (repeat) return;
		if (this._wheelOpen && this._wheelMode === 'sticky') { this.closeWheel(); return; }
		this.openWheel('hold');
		this._bindHoldPointer();
	}

	/** keyup handler for `G`. */
	wheelKeyUp() {
		if (!this._wheelOpen) return;
		if (this._wheelMode === 'hold') {
			this._unbindHoldPointer();
			// A quick tap (no segment chosen, pointer never moved over a slot)
			// promotes to a sticky wheel the user can click; a hold-and-aim commits.
			if (this._highlight >= 0) this.commitWheel();
			else this._wheelMode = 'sticky';
		}
	}

	_bindHoldPointer() {
		if (this._holdMove) return;
		this._holdMove = (e) => this._highlightFromPoint(e.clientX, e.clientY);
		window.addEventListener('pointermove', this._holdMove, { passive: true });
	}

	_unbindHoldPointer() {
		if (this._holdMove) {
			window.removeEventListener('pointermove', this._holdMove);
			this._holdMove = null;
		}
	}

	// ── Mobile: long-press the action button ─────────────────────────────────

	/** Wire a touch/click action button to open the wheel (long-press) or toggle (tap). */
	attachTouchButton(btn) {
		if (!btn) return;
		let pressTimer = null;
		let longPressed = false;
		let moveHandler = null;

		const startAim = () => {
			longPressed = true;
			this.openWheel('hold');
			moveHandler = (e) => {
				const t = e.touches?.[0] || e;
				if (t) this._highlightFromPoint(t.clientX, t.clientY);
			};
			window.addEventListener('pointermove', moveHandler, { passive: true });
		};

		const onDown = (e) => {
			longPressed = false;
			pressTimer = setTimeout(startAim, LONG_PRESS_MS);
		};
		const endAim = () => {
			clearTimeout(pressTimer);
			if (moveHandler) { window.removeEventListener('pointermove', moveHandler); moveHandler = null; }
			if (longPressed) {
				// Released after aiming — commit the highlighted slot (or just close).
				this.commitWheel();
			} else {
				// Short tap → toggle a sticky wheel the user picks from.
				if (this._wheelOpen) this.closeWheel(); else this.openWheel('sticky');
			}
		};

		btn.addEventListener('pointerdown', onDown);
		btn.addEventListener('pointerup', endAim);
		btn.addEventListener('pointercancel', () => { clearTimeout(pressTimer); if (moveHandler) { window.removeEventListener('pointermove', moveHandler); moveHandler = null; } });
		this._touchCleanup = () => {
			btn.removeEventListener('pointerdown', onDown);
			btn.removeEventListener('pointerup', endAim);
		};
	}

	// ── Quick-access side tray ───────────────────────────────────────────────

	/** Populate a persistent quick-access tray (the existing #walk-emote-tray). */
	buildTray(trayEl) {
		if (!trayEl) return;
		this._trayEl = trayEl;
		trayEl.hidden = false;
		trayEl.innerHTML = '';
		for (const g of this.list()) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'walk-emote-btn';
			btn.dataset.gesture = g.name;
			btn.title = g.label;
			btn.setAttribute('aria-pressed', 'false');
			btn.setAttribute('aria-label', g.label);
			btn.innerHTML = `<span>${g.icon}</span><span class="emote-label">${g.label}</span>`;
			btn.addEventListener('click', () => this.play(g.name));
			trayEl.appendChild(btn);
		}
	}

	_syncTray() {
		if (!this._trayEl) return;
		const active = this.machine.getGesture();
		this._trayEl.querySelectorAll('.walk-emote-btn').forEach((b) => {
			b.setAttribute('aria-pressed', String(b.dataset.gesture === active));
		});
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	destroy() {
		if (this._destroyed) return;
		this._destroyed = true;
		clearTimeout(this._loopSafetyTimer);
		this._unbindHoldPointer();
		this._touchCleanup?.();
		try { this.animationManager.stopOverlay({ crossfade: 0 }); } catch { /* detached */ }
		this._wheelEl?.remove();
		this._wheelEl = null;
	}
}
