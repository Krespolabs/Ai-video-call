// GameFeel — the polish layer: screen feedback (damage vignette, money pops,
// level-up flourish, hit flash), a tiny procedural WebAudio SFX kit (no asset
// files — synthesised envelopes), and haptics. Other systems call into it so the
// world *feels* responsive: the HUD pops cash, the camera rig shakes, menus tick.
//
// Audio is opt-in-safe: the AudioContext is created lazily on the first real
// gesture and respects a persisted mute toggle. Everything degrades silently
// where a capability is missing (no vibrate, no WebAudio).

import './game-feel.css';

const MUTE_KEY = 'wh-sfx-muted';

export class GameFeel {
	constructor() {
		this._muted = (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } })();
		this._ctx = null;
		this._master = null;
		this._buildOverlay();
		// Unlock audio on the first gesture so menu ticks aren't swallowed by the
		// browser autoplay policy.
		const unlock = () => { this._ensureAudio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
		window.addEventListener('pointerdown', unlock, { once: true });
		window.addEventListener('keydown', unlock, { once: true });
	}

	_buildOverlay() {
		const o = document.createElement('div');
		o.className = 'wh-feel';
		o.setAttribute('aria-hidden', 'true');
		this.vignette = document.createElement('div'); this.vignette.className = 'wh-feel-vignette';
		this.flash = document.createElement('div'); this.flash.className = 'wh-feel-flash';
		o.append(this.vignette, this.flash);
		document.body.appendChild(o);
		this.root = o;
	}

	// ------------------------------------------------------------------- audio
	_ensureAudio() {
		if (this._ctx || this._muted) return this._ctx;
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		try {
			this._ctx = new AC();
			this._master = this._ctx.createGain();
			this._master.gain.value = 0.18;
			this._master.connect(this._ctx.destination);
		} catch { this._ctx = null; }
		return this._ctx;
	}

	setMuted(m) {
		this._muted = !!m;
		try { localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0'); } catch { /* ignore */ }
		if (this._master) this._master.gain.value = this._muted ? 0 : 0.18;
	}
	isMuted() { return this._muted; }

	// One synthesised blip. `type` shapes a short envelope; tuned to feel like a
	// clean UI kit rather than a beep.
	sfx(type = 'select') {
		if (this._muted) return;
		const ctx = this._ensureAudio();
		if (!ctx) return;
		if (ctx.state === 'suspended') ctx.resume().catch(() => {});
		const now = ctx.currentTime;
		const voices = {
			open:    { f: 520, f2: 720, dur: 0.12, wave: 'sine', gain: 0.5 },
			select:  { f: 660, f2: 660, dur: 0.05, wave: 'square', gain: 0.28 },
			confirm: { f: 540, f2: 880, dur: 0.16, wave: 'triangle', gain: 0.6 },
			back:    { f: 420, f2: 300, dur: 0.1, wave: 'sine', gain: 0.4 },
			error:   { f: 200, f2: 150, dur: 0.18, wave: 'sawtooth', gain: 0.4 },
			cash:    { f: 880, f2: 1320, dur: 0.14, wave: 'triangle', gain: 0.5 },
			level:   { f: 660, f2: 1320, dur: 0.32, wave: 'triangle', gain: 0.7 },
			damage:  { f: 160, f2: 90, dur: 0.22, wave: 'sawtooth', gain: 0.55 },
			tick:    { f: 1200, f2: 1200, dur: 0.025, wave: 'square', gain: 0.18 },
		};
		const v = voices[type] || voices.select;
		const osc = ctx.createOscillator();
		const g = ctx.createGain();
		osc.type = v.wave;
		osc.frequency.setValueAtTime(v.f, now);
		osc.frequency.exponentialRampToValueAtTime(Math.max(40, v.f2), now + v.dur);
		g.gain.setValueAtTime(0.0001, now);
		g.gain.exponentialRampToValueAtTime(v.gain, now + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, now + v.dur);
		osc.connect(g); g.connect(this._master);
		osc.start(now); osc.stop(now + v.dur + 0.02);
	}

	// ----------------------------------------------------------------- haptics
	haptic(pattern = 12) {
		try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ }
	}

	// ---------------------------------------------------------------- feedback
	// Red edge-vignette pulse for taking damage. `intensity` 0..1.
	damage(intensity = 0.6) {
		const v = Math.max(0.15, Math.min(1, intensity));
		this.vignette.style.setProperty('--feel-vig', String(v));
		this.vignette.classList.remove('is-hit');
		void this.vignette.offsetWidth;
		this.vignette.classList.add('is-hit');
		this.sfx('damage');
		this.haptic([18, 30, 18]);
	}

	// Quick white screen flash (pickup, teleport, photo).
	flashScreen(color = 'rgba(255,255,255,0.5)') {
		this.flash.style.background = color;
		this.flash.classList.remove('is-on');
		void this.flash.offsetWidth;
		this.flash.classList.add('is-on');
	}

	// Floating "+$120" / "−$40" near an anchor element (the cash readout).
	moneyPop(delta, anchorEl) {
		const d = Math.round(Number(delta) || 0);
		if (!d) return;
		const chip = document.createElement('div');
		chip.className = 'wh-feel-money ' + (d > 0 ? 'is-up' : 'is-down');
		chip.textContent = (d > 0 ? '+$' : '−$') + Math.abs(d).toLocaleString();
		const r = anchorEl?.getBoundingClientRect();
		if (r) { chip.style.left = `${r.left + r.width / 2}px`; chip.style.top = `${r.bottom + 4}px`; }
		else { chip.style.right = '16px'; chip.style.top = '140px'; }
		document.body.appendChild(chip);
		requestAnimationFrame(() => chip.classList.add('is-go'));
		setTimeout(() => chip.remove(), 1100);
		this.sfx('cash');
	}

	// Center-screen level-up / achievement flourish.
	flourish(title, sub = '') {
		const card = document.createElement('div');
		card.className = 'wh-feel-flourish';
		const t = document.createElement('div'); t.className = 'wh-feel-flourish-title'; t.textContent = title;
		card.appendChild(t);
		if (sub) { const s = document.createElement('div'); s.className = 'wh-feel-flourish-sub'; s.textContent = sub; card.appendChild(s); }
		document.body.appendChild(card);
		requestAnimationFrame(() => card.classList.add('is-show'));
		setTimeout(() => { card.classList.remove('is-show'); setTimeout(() => card.remove(), 420); }, 2200);
		this.sfx('level');
		this.haptic([10, 40, 10, 40, 20]);
	}

	dispose() {
		this.root?.remove();
		document.querySelectorAll('.wh-feel-money, .wh-feel-flourish').forEach((n) => n.remove());
		try { this._ctx?.close(); } catch { /* ignore */ }
	}
}
