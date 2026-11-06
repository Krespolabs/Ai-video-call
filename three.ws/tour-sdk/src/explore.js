// explore.js — the interactive "checkpoint" mode.
// ================================================
// The visitor drives the avatar themselves to glowing GTA-style checkpoints
// anchored to each tour stop. Walk the character into the active checkpoint and
// it stops, spotlights the section, and explains it; the next one lights up
// until they've found them all.
//
// The locomotion is the REAL @three-ws/walk playground, with both of its
// movement models: "stroll" (free walking/running, the page scrolls under the
// character) and "platformer" (the page's real DOM is solid ground — gravity,
// jumping, falling). The host picks the starting model (`mode: 'platformer'` /
// data-mode="platformer"), and the visitor can hop between the two mid-quest
// with the M key or the mode pill — checkpoints and progress carry across.
// This module just supplies the checkpoints and narrates each one (via the
// tour's own Spotlight and Narrator) when the playground reports the character
// reached it.

import {
	launchPlayground,
	exitPlayground,
	switchPlaygroundMode,
	getPlaygroundMode,
	resolveConfig,
} from '@three-ws/walk';
import { Spotlight } from './spotlight.js';
import { Narrator } from './narrator.js';
import { normalizePath } from './curriculum.js';

const Z_HUD = 2147483400;

export class ExploreMode {
	constructor(config, curriculum) {
		this.config = config;
		this.curriculum = curriculum;
		// Starting movement model — 'platformer' turns the page into solid ground
		// with gravity and jumping; anything else is the default free 'stroll'.
		this.movement = config.mode === 'platformer' ? 'platformer' : 'stroll';
		this.spotlight = null;
		this.narrator = null;
		this.stops = [];
		this.pg = null;
		this.running = false;
		this._reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		// The playground owns Esc (exit) and M (mode switch); mirror both so the
		// tour HUD never outlives the avatar and its help text tracks the mode.
		this._onPgExit = () => {
			if (this.running) this.exit();
		};
		this._onPgMode = () => {
			if (this.running && this._hudState) this._setHud(...this._hudState);
		};
	}

	isActive() {
		return this.running;
	}

	async start() {
		if (this.running) return;
		this.running = true;

		// Explore is a single-surface experience — only stops resolvable on the
		// current page take part (an unreachable checkpoint helps no one).
		const here = normalizePath();
		const candidates = (this.curriculum?.stops || []).filter(
			(s) => !s.path || normalizePath(s.path) === here,
		);
		this.stops = candidates
			.map((stop) => ({ stop, el: this._resolveTarget(stop) }))
			.filter((s) => s.el);

		if (!this.stops.length) {
			this._toast('Nothing to explore on this page yet.');
			this.exit();
			return;
		}

		this.spotlight = new Spotlight();
		this.narrator = new Narrator(this.config);
		this._buildHud();

		// Fresh playground with our checkpoints. exit any existing one first so the
		// singleton adopts our config + checkpoint list (not a stale companion one).
		exitPlayground();
		window.scrollTo({ top: 0, behavior: 'auto' });
		this.pg = launchPlayground({
			mode: this.movement,
			config: this._walkConfig(),
			avatarId: this.config.guideAvatarId,
			checkpoints: this.stops.map((s) => ({ el: s.el })),
			onReach: (i, resume) => this._reach(i, resume),
			onComplete: () => this._finish(),
		});
		window.addEventListener('walk-playground:exit', this._onPgExit);
		window.addEventListener('walk-playground:mode', this._onPgMode);

		this._activate(0);
	}

	exit() {
		this.running = false;
		window.removeEventListener('walk-playground:exit', this._onPgExit);
		window.removeEventListener('walk-playground:mode', this._onPgMode);
		try {
			exitPlayground();
		} catch {}
		this.pg = null;
		this.narrator?.cancel?.();
		this.spotlight?.dispose();
		this.spotlight = null;
		this._hud?.remove();
		this._hud = null;
	}

	// ── Reaching a checkpoint ─────────────────────────────────────────────────
	async _reach(i, resume) {
		const { stop, el } = this.stops[i];
		this._setHud(i, true);
		await this.spotlight.highlight(el);
		await this.narrator.speak(stop.narration, {
			muted: false,
			voice: this.config.defaultVoice,
			speed: 1,
		});
		if (!this.running) return;
		this.spotlight.highlight(null);
		const next = i + 1;
		if (next < this.stops.length) this._activate(next);
		resume(); // hands control back to the playground for the next leg
	}

	_activate(i) {
		this._setHud(i, false);
	}

	_finish() {
		this.spotlight?.highlight(null);
		this._setHud(this.stops.length - 1, false, true);
	}

	// ── HUD ───────────────────────────────────────────────────────────────────
	_buildHud() {
		const hud = document.createElement('div');
		hud.className = 'tws-cp-hud';
		hud.innerHTML = `
			<div class="tws-cp-hud__row">
				<span class="tws-cp-hud__badge" id="tws-cp-count"></span>
				<span class="tws-cp-hud__msg" id="tws-cp-msg"></span>
			</div>
			<div class="tws-cp-hud__dots" id="tws-cp-dots"></div>
			<button class="tws-cp-hud__mode" id="tws-cp-mode" type="button" aria-label="Switch movement mode">
				<span class="tws-cp-hud__mode-ic" id="tws-cp-mode-ic">🚶</span>
				<span id="tws-cp-mode-name">Stroll</span>
				<span class="tws-cp-hud__mode-swap">tap or press M to switch</span>
			</button>
			<button class="tws-cp-hud__exit" id="tws-cp-exit" aria-label="Exit">✕ Exit</button>`;
		injectHudStyles();
		document.body.appendChild(hud);
		this._hud = hud;
		hud.querySelector('#tws-cp-dots').innerHTML = this.stops.map(() => '<i></i>').join('');
		hud.querySelector('#tws-cp-exit').addEventListener('click', () => this.exit());
		hud.querySelector('#tws-cp-mode').addEventListener('click', () => switchPlaygroundMode());
		this._reachedCount = 0;
		this._syncMode();
	}

	// Keep the HUD's mode toggle showing the live movement model. Fired on build
	// and whenever the playground reports a switch (walk-playground:mode).
	_syncMode() {
		if (!this._hud) return;
		const platformer = getPlaygroundMode() === 'platformer';
		const ic = this._hud.querySelector('#tws-cp-mode-ic');
		const name = this._hud.querySelector('#tws-cp-mode-name');
		if (ic) ic.textContent = platformer ? '🎮' : '🚶';
		if (name) name.textContent = platformer ? 'Platformer' : 'Stroll';
	}

	_setHud(i, talking, done = false) {
		if (!this._hud) return;
		this._hudState = [i, talking, done];
		this._syncMode();
		const total = this.stops.length;
		if (talking) this._reachedCount = Math.max(this._reachedCount || 0, i + 1);
		const reached = done ? total : this._reachedCount || 0;
		const count = this._hud.querySelector('#tws-cp-count');
		const msg = this._hud.querySelector('#tws-cp-msg');
		const dots = [...this._hud.querySelectorAll('#tws-cp-dots i')];
		dots.forEach((d, idx) => {
			d.classList.toggle('done', idx < reached);
			d.classList.toggle('active', idx === i && idx >= reached);
		});
		if (done) {
			count.textContent = '🎉 All done';
			msg.textContent = `You found all ${total} spots. Press ✕ to finish.`;
			return;
		}
		count.textContent = `🎯 ${reached} / ${total}`;
		msg.textContent = talking ? this.stops[i].stop.title || 'Here we are' : this._instruction();
	}

	// Movement help that tracks the LIVE playground mode — the visitor can flip
	// between stroll and platformer mid-quest with M / the mode pill.
	_instruction() {
		const platformer = getPlaygroundMode() === 'platformer';
		if (this._touch()) {
			return platformer
				? 'Use the buttons to run and jump to the glowing checkpoint.'
				: 'Use the joystick to walk to the glowing checkpoint.';
		}
		return platformer
			? 'Arrow keys to run, Space to jump — reach the glowing checkpoint.'
			: 'Use arrow keys to walk to the glowing checkpoint.';
	}

	_touch() {
		return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
	}

	// ── Helpers ───────────────────────────────────────────────────────────────
	_walkConfig() {
		// Build a fully-resolved walk config (keys, excluded routes, roster, …) from
		// the tour's asset settings — the playground reads far more than the four
		// fields below, so a raw object would break it.
		return resolveConfig({
			assetBase: this.config.assetBase || '',
			apiBase: this.config.apiBase || '',
			manifestUrl: this.config.manifestUrl || '/animations/manifest.json',
			defaultAvatarId: this.config.guideAvatarId || 'realistic-female',
		});
	}

	_resolveTarget(stop) {
		const selectors = [
			...(stop.targets || []),
			'[data-tour-target]',
			'main h1, .hero h1, h1',
			'a.cta, .btn-primary, button[type="submit"], main a.button, .hero a',
		];
		for (const sel of selectors) {
			let el;
			try {
				el = document.querySelector(sel);
			} catch {
				continue;
			}
			if (isVisible(el)) return el;
		}
		return null;
	}

	_toast(text) {
		const t = document.createElement('div');
		t.className = 'tws-cp-toast';
		t.textContent = text;
		injectHudStyles();
		document.body.appendChild(t);
		requestAnimationFrame(() => t.classList.add('is-in'));
		setTimeout(() => {
			t.classList.remove('is-in');
			setTimeout(() => t.remove(), 300);
		}, 2600);
	}
}

function isVisible(el) {
	if (!el || !el.isConnected) return false;
	const r = el.getBoundingClientRect();
	if (r.width < 4 || r.height < 4) return false;
	const style = getComputedStyle(el);
	return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

let _hudStyles = false;
function injectHudStyles() {
	if (_hudStyles || typeof document === 'undefined') return;
	_hudStyles = true;
	const style = document.createElement('style');
	style.id = 'tws-tour-explore-hud';
	style.textContent = `
.tws-cp-hud{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:${Z_HUD};display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 18px;background:rgba(14,16,22,.94);backdrop-filter:blur(12px);border:1px solid rgba(122,162,255,.28);border-radius:16px;color:#e7eaf2;font:600 13px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.5);max-width:min(520px,94vw)}
.tws-cp-hud__row{display:flex;align-items:center;gap:12px}
.tws-cp-hud__badge{font-weight:800;white-space:nowrap}
.tws-cp-hud__msg{color:#aeb6c8}
.tws-cp-hud__dots{display:flex;gap:6px}
.tws-cp-hud__dots i{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.18);transition:.2s}
.tws-cp-hud__dots i.active{background:#6ee7b7;box-shadow:0 0 8px rgba(110,231,183,.8);transform:scale(1.2)}
.tws-cp-hud__dots i.done{background:#34d399}
.tws-cp-hud__mode{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(122,162,255,.4);background:rgba(122,162,255,.14);color:#e7eaf2;font:700 12px/1 inherit;padding:8px 13px;border-radius:999px;cursor:pointer;pointer-events:auto;transition:background .18s ease,border-color .18s ease,transform .12s ease}
.tws-cp-hud__mode:hover{background:rgba(122,162,255,.3);border-color:rgba(122,162,255,.65)}
.tws-cp-hud__mode:active{transform:scale(.97)}
.tws-cp-hud__mode:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.tws-cp-hud__mode-ic{font-size:14px;line-height:1}
.tws-cp-hud__mode-swap{color:#aeb6c8;font-weight:600;font-size:11px}
.tws-cp-hud__exit{position:absolute;top:-14px;right:-10px;border:1px solid rgba(255,255,255,.16);background:rgba(20,24,34,.95);color:#cfd5e4;font:700 11px/1 inherit;padding:6px 10px;border-radius:99px;cursor:pointer;pointer-events:auto}
.tws-cp-hud__exit:hover{color:#fff;border-color:rgba(248,113,113,.7)}
.tws-cp-toast{position:fixed;left:50%;top:20px;transform:translateX(-50%) translateY(-10px);z-index:${Z_HUD};padding:11px 18px;background:rgba(14,16,22,.95);border:1px solid rgba(122,162,255,.3);border-radius:12px;color:#e7eaf2;font:600 13px/1.3 system-ui,sans-serif;opacity:0;transition:.3s;box-shadow:0 10px 30px rgba(0,0,0,.5)}
.tws-cp-toast.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
`;
	document.head.appendChild(style);
}
