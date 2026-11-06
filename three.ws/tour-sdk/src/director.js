// director.js — the brain of the tour. It walks the curriculum stop by stop:
// for each one it finds the real on-page element to showcase, spotlights it,
// walks the guide avatar over to point at it, draws a beam from the avatar to
// the feature, speaks the narration, and — unless paused — advances. When the
// next stop lives on another route it persists progress and navigates; the tour
// re-hydrates from sessionStorage on the new page and picks up exactly where it
// left off. One module owns all of that sequencing and every control.
//
// Navigation is expressed over a *playlist* — the ordered list of stop indices
// the chosen track visits (the Full track is every stop; the Quick track is the
// highlighted heroes). `pos` is where we are in that playlist; `index` is the
// absolute curriculum stop it points at. Switching tracks re-derives the
// playlist and re-anchors `pos` to the nearest stop, so the tour never loses its
// place. The chapter panel can jump to any stop, expanding to the Full track if
// the requested stop isn't in the current one.

import {
	loadCurriculum,
	createTourState,
	buildPlaylist,
	normalizePath,
	stopIndexForPath,
	sectionTitle,
} from './curriculum.js';
import { resolveTourConfig } from './config.js';
import { GuideAvatar } from './guide-avatar.js';
import { Spotlight } from './spotlight.js';
import { Narrator } from './narrator.js';
import { TourControls } from './controls.js';
import { ChapterPanel } from './chapters.js';
import { FreeRoam } from './free-roam.js';

const ADVANCE_BEAT_MS = 900; // pause between finishing a stop and moving on
const Z_BEAM = 2147483280;
const SPEED_CYCLE = [1, 1.25, 1.5, 0.75];

export class TourDirector {
	constructor(config) {
		this.config = config && config.keys ? config : resolveTourConfig(config);
		this.state = createTourState(this.config);
		this.curriculum = null;
		this.playlist = [];
		this.pos = 0;
		this.index = 0;
		this.track = 'full';
		this.paused = false;
		this.muted = false;
		this.voice = this.config.defaultVoice;
		this.speed = 1;
		this.mounted = false;
		this.offRoute = false;
		this.roam = false;
		this._runToken = 0;
		this._advanceTimer = 0;
		this._seenSections = new Set();
		this._beamRaf = 0;
		this._beamActive = false;
		this._onKey = this._onKey.bind(this);
	}

	// ── Entry points ──────────────────────────────────────────────────────────

	// Begin a fresh tour from the very first stop (called by the host's "Start
	// tour" action / the deep-link). `track` chooses Quick vs Full; voice/speed
	// default to the visitor's remembered preferences. Navigates to stop 0's page
	// if needed.
	async start(track) {
		await this._ensureCurriculum();
		const prefs = this.state.readResume();
		this.track = track || 'full';
		this.voice = prefs.voice || this.config.defaultVoice;
		this.speed = prefs.speed || 1;
		this.muted = false;
		this.paused = false;
		this._seenSections = new Set();
		this.playlist = buildPlaylist(this.curriculum, this.track);
		this.pos = 0;
		this.index = this.playlist[0] ?? 0;
		this.state.writeState({
			active: true,
			index: this.index,
			track: this.track,
			voice: this.voice,
			speed: this.speed,
			paused: false,
			muted: false,
		});
		const first = this.curriculum.stops[this.index];
		if (normalizePath(first.path) !== normalizePath()) {
			this._navigate(first.path);
			return;
		}
		await this._mount();
		this._runCurrent();
	}

	// Re-hydrate on a normal page load when a tour is already in progress.
	async resume() {
		const state = this.state.readState();
		if (!state.active) return;
		await this._ensureCurriculum();
		this.paused = state.paused;
		this.muted = state.muted;
		this.voice = state.voice || this.config.defaultVoice;
		this.speed = state.speed || 1;
		this.track = state.track || 'full';
		this.playlist = buildPlaylist(this.curriculum, this.track);

		const here = stopIndexForPath(this.curriculum, location.pathname);
		const wanted = state.index || 0;
		if (normalizePath(this.curriculum.stops[wanted]?.path) === normalizePath()) {
			this.index = wanted; // arrived exactly where we were heading
			this.offRoute = false;
		} else if (here >= 0) {
			this.index = here; // visitor hand-navigated to another stop's page
			this.offRoute = false;
			this.state.writeState({ index: here });
		} else {
			this.index = wanted; // wandered off the route entirely
			this.offRoute = true;
		}
		this.pos = this._posForAbs(this.index);

		await this._mount();
		if (this.offRoute) {
			this._showOffRoute();
		} else {
			this._runCurrent();
		}
	}

	async _ensureCurriculum() {
		if (!this.curriculum) this.curriculum = await loadCurriculum(this.config);
	}

	// ── Mounting ──────────────────────────────────────────────────────────────
	async _mount() {
		if (this.mounted) return;
		this.mounted = true;
		// A companion avatar (e.g. the @three-ws/walk corner mascot) would just be a
		// second body on screen during the tour, so stand it down (and its
		// click-to-walk, which would otherwise fight free roam) and bring it back
		// when the tour ends.
		this._suppressCompanion();
		this._buildBeam();
		this.spotlight = new Spotlight();
		this.narrator = new Narrator(this.config);
		this.avatar = new GuideAvatar(this.config);
		await this.avatar.mount();
		this.freeRoam = new FreeRoam(this.avatar);
		this.controls = new TourControls({
			onMenu: () => this.panel?.toggle(),
			onPrev: () => this._go(this.pos - 1),
			onNext: () => this._go(this.pos + 1),
			onToggle: () => this._togglePause(),
			onSeek: (i) => this._go(i),
			onSpeed: () => this._cycleSpeed(),
			onRoam: () => this._toggleRoam(),
			onMute: () => this._toggleMute(),
			onExit: () => this.exit(),
		});
		this.panel = new ChapterPanel(
			this.curriculum,
			{
				onJump: (abs) => this._jumpToAbs(abs),
				onTrack: (t) => this._applyTrack(t),
				onSpeed: (v) => this._setSpeed(v),
				onVoice: (v) => this._setVoice(v),
				onOpenChange: (open) => this.controls.setMenuOpen(open),
			},
			this.config.voices,
		);
		this.controls.setMuted(this.muted);
		this.controls.setPaused(this.paused);
		this.controls.setSpeed(this.speed);
		this.panel.setTrack(this.track);
		this.panel.setSpeed(this.speed);
		this.panel.setVoice(this.voice);
		document.addEventListener('keydown', this._onKey);
	}

	// ── Running a stop ────────────────────────────────────────────────────────
	async _runCurrent() {
		const token = ++this._runToken;
		clearTimeout(this._advanceTimer);
		this.offRoute = false;
		const stop = this.curriculum.stops[this.index];
		if (!stop) return this._finish();

		this._syncControls();
		this.panel?.setActive(this.index);
		this.state.writeState({ index: this.index });

		// Chapter bridge — spoken once per section per session.
		if (stop.sectionIntro && !this._seenSections.has(stop.section)) {
			this._seenSections.add(stop.section);
			await this.avatar.park();
			if (token !== this._runToken) return;
			this.avatar.point();
			await this._present(stop.sectionIntro, token);
			if (token !== this._runToken) return;
		}

		// Move to the feature and point at it.
		const target = this._resolveTarget(stop);
		if (target) {
			await this.spotlight.highlight(target);
			if (token !== this._runToken) return;
			await this.avatar.approach(this.spotlight.getRect() || rectOf(target));
			if (token !== this._runToken) return;
			this._startBeam();
		} else {
			this.spotlight.highlight(null);
			this._stopBeam();
			await this.avatar.park();
			if (token !== this._runToken) return;
		}
		this.avatar.point();

		await this._narrateAndMaybeAdvance(token);
	}

	async _narrateAndMaybeAdvance(token) {
		await this._present(this.curriculum.stops[this.index].narration, token);
		if (token !== this._runToken) return;
		if (this.paused) return;
		this._advanceTimer = setTimeout(() => {
			if (token === this._runToken) this._advance();
		}, ADVANCE_BEAT_MS / this.speed);
	}

	// Show caption + speak; resolves when the voice (or timed fallback) ends.
	async _present(text, token) {
		this.avatar.say(text);
		await this.narrator.speak(text, { muted: this.muted, voice: this.voice, speed: this.speed });
	}

	_advance() {
		if (this.pos + 1 >= this.playlist.length) return this._finish();
		this._go(this.pos + 1);
	}

	// Go to a playlist position (prev / next / scrub / advance / jump). Cancels
	// anything in flight, then runs the stop here or navigates if it's off-page.
	_go(pos) {
		if (!this.playlist.length) return;
		if (this.roam) {
			// Any explicit navigation leaves free roam and resumes the guided tour.
			this.roam = false;
			this.freeRoam?.disable();
			this.controls?.setRoam(false);
		}
		const clamped = Math.max(0, Math.min(this.playlist.length - 1, pos));
		this._runToken++;
		clearTimeout(this._advanceTimer);
		this.narrator?.cancel();
		this.pos = clamped;
		this.index = this.playlist[clamped];
		this.state.writeState({ index: this.index });
		this.panel?.setActive(this.index);
		const stop = this.curriculum.stops[this.index];
		if (normalizePath(stop.path) === normalizePath()) {
			this._runCurrent();
		} else {
			this._navigate(stop.path);
		}
	}

	// Jump to an absolute curriculum stop from the chapter panel. If it isn't in
	// the current track's playlist, expand to the Full track so every stop is
	// reachable, then go to it.
	_jumpToAbs(abs) {
		if (this.playlist.indexOf(abs) < 0) this._applyTrack('full', { silent: true });
		this._go(this._posForAbs(abs));
	}

	_togglePause() {
		if (this.roam) return this._exitRoam(); // play rejoins the tour from roam
		this.paused = !this.paused;
		this.state.writeState({ paused: this.paused });
		this.controls.setPaused(this.paused);
		if (this.paused) {
			clearTimeout(this._advanceTimer);
			this.narrator.cancel();
			this._runToken++; // freeze the current sequence
		} else if (this.offRoute) {
			this._go(this.pos);
		} else {
			// Resume re-narrates the current stop, then continues.
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	_toggleMute() {
		this.muted = !this.muted;
		this.state.writeState({ muted: this.muted });
		this.controls.setMuted(this.muted);
		this.narrator.cancel();
		if (!this.paused) {
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	// ── Track / speed / voice ───────────────────────────────────────────────────
	_applyTrack(track, { silent = false } = {}) {
		if (track === this.track) return;
		const abs = this.index;
		this.track = track;
		this.playlist = buildPlaylist(this.curriculum, track);
		this.pos = this._posForAbs(abs);
		this.index = this.playlist[this.pos];
		this.state.writeState({ track, index: this.index });
		this.panel?.setTrack(track);
		this._syncControls();
		if (!silent) this._go(this.pos); // re-anchor to the (possibly new) stop
	}

	_cycleSpeed() {
		const i = SPEED_CYCLE.indexOf(this.speed);
		this._setSpeed(SPEED_CYCLE[(i + 1) % SPEED_CYCLE.length]);
	}

	_setSpeed(value) {
		const next = Math.min(2, Math.max(0.5, Number(value) || 1));
		if (next === this.speed) return;
		this.speed = next;
		this.state.writeState({ speed: next });
		this.controls?.setSpeed(next);
		this.panel?.setSpeed(next);
		// Re-narrate the current stop at the new rate if we're actively playing.
		if (!this.paused && !this.offRoute && this.mounted) {
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	_setVoice(value) {
		if (!value || value === this.voice) return;
		this.voice = value;
		this.state.writeState({ voice: value });
		this.panel?.setVoice(value);
		if (!this.paused && !this.offRoute && this.mounted) {
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	// ── Free roam ───────────────────────────────────────────────────────────────
	// Hand the stage to the visitor: freeze the guided sequence and let them drive
	// the guide around the page (free-roam.js). Toggling off — or any navigation /
	// play — rejoins the tour at the current stop.
	_toggleRoam() {
		this.roam ? this._exitRoam() : this._enterRoam();
	}

	_enterRoam() {
		if (this.roam) return;
		this.roam = true;
		this._runToken++; // freeze whatever the guide was doing
		clearTimeout(this._advanceTimer);
		this.narrator?.cancel();
		this._stopBeam();
		this.spotlight?.highlight(null);
		this.avatar?.hideBubble();
		this.panel?.close();
		this.controls?.setRoam(true);
		this.freeRoam?.enable();
	}

	_exitRoam() {
		if (!this.roam) return;
		this.roam = false;
		this.freeRoam?.disable();
		this.controls?.setRoam(false);
		// Rejoining the tour means playing again from the current stop.
		this.paused = false;
		this.controls?.setPaused(false);
		this.state.writeState({ paused: false });
		this._go(this.pos);
	}

	// ── Companion suppression (de-dupe the on-screen avatar) ─────────────────────
	_suppressCompanion() {
		const cfg = this.config.companion;
		if (!cfg) return;
		const w = window[cfg.global];
		if (!w) return;
		this._companionWasOn = !!(w.instance?.mounted || (w.isEnabled && w.isEnabled()));
		const hide = () => {
			try {
				if (w.instance?.mounted) w.instance.unmount();
			} catch {
				/* companion mid-mount — the change listener will catch it */
			}
		};
		hide();
		// The companion auto-mounts on load (and on playground return); re-hide it
		// whenever it reappears while the tour owns the screen.
		this._onCompanionChange = hide;
		window.addEventListener(cfg.changeEvent, this._onCompanionChange);
	}

	_restoreCompanion() {
		const cfg = this.config.companion;
		if (cfg && this._onCompanionChange) {
			window.removeEventListener(cfg.changeEvent, this._onCompanionChange);
			this._onCompanionChange = null;
		}
		if (!cfg) return;
		const w = window[cfg.global];
		if (!w || !this._companionWasOn) return;
		try {
			if (!w.instance?.mounted) (w.instance ? w.instance.mount() : w.enable?.());
		} catch {
			/* non-fatal — the companion will re-mount on the next page load */
		}
	}

	// Playlist position for an absolute stop index — exact match, else nearest.
	_posForAbs(abs) {
		const p = this.playlist.indexOf(abs);
		if (p >= 0) return p;
		let best = 0;
		let bestD = Infinity;
		this.playlist.forEach((a, i) => {
			const d = Math.abs(a - abs);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		});
		return best;
	}

	// ── Off-route recovery ────────────────────────────────────────────────────
	_showOffRoute() {
		this._stopBeam();
		this.spotlight.highlight(null);
		this.avatar.park();
		this.paused = true;
		this.state.writeState({ paused: true });
		this.controls.setPaused(true);
		this._syncControls();
		this.panel?.setActive(this.index);
		this.avatar.say(this.config.copy.offRoute);
	}

	// ── Finish ────────────────────────────────────────────────────────────────
	async _finish() {
		const token = ++this._runToken;
		this._stopBeam();
		this.spotlight.highlight(null);
		await this.avatar.park();
		this.avatar.point();
		await this._present(this.config.copy.outro, token);
		if (token !== this._runToken) return;
		this.state.markCompleted();
		this.state.clearState();
		document.removeEventListener('keydown', this._onKey);
		this._showCompletion();
	}

	_showCompletion() {
		const done = this.config.copy.completion;
		const card = document.createElement('div');
		card.className = 'tws-tour-done';
		const primary = done.primary
			? `<a class="tws-tour-done__btn tws-tour-done__btn--primary" href="${escAttr(done.primary.href)}">${escHtml(done.primary.label)}</a>`
			: '';
		card.innerHTML = `
			<div class="tws-tour-done__inner" role="dialog" aria-label="Tour complete">
				<div class="tws-tour-done__title">${escHtml(done.title)}</div>
				<p class="tws-tour-done__body">${escHtml(done.body)}</p>
				<div class="tws-tour-done__actions">
					${primary}
					<button class="tws-tour-done__btn" data-act="restart">${escHtml(done.restartLabel)}</button>
					<button class="tws-tour-done__btn" data-act="close">${escHtml(done.closeLabel)}</button>
				</div>
			</div>`;
		ensureDoneStyles();
		document.body.appendChild(card);
		requestAnimationFrame(() => card.classList.add('is-in'));
		card.addEventListener('click', (e) => {
			const act = e.target.closest('[data-act]')?.dataset.act;
			if (act === 'restart') {
				card.remove();
				this.start(this.track);
			} else if (act === 'close') {
				card.remove();
				this.exit();
			}
		});
		this._doneCard = card;
	}

	// ── Teardown ──────────────────────────────────────────────────────────────
	exit() {
		this._runToken++;
		clearTimeout(this._advanceTimer);
		this.state.clearState();
		this._stopBeam();
		this._beam?.remove();
		document.removeEventListener('keydown', this._onKey);
		this.roam = false;
		this.freeRoam?.disable();
		this.narrator?.dispose();
		this.spotlight?.dispose();
		this.avatar?.dispose();
		this.controls?.dispose();
		this.panel?.dispose();
		this._doneCard?.remove();
		this._restoreCompanion();
		this.mounted = false;
	}

	// ── Target resolution ─────────────────────────────────────────────────────
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

	// ── Pointer beam (avatar → feature) ───────────────────────────────────────
	_buildBeam() {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'tws-tour-beam');
		svg.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;z-index:${Z_BEAM};pointer-events:none;opacity:0;transition:opacity .3s ease`;
		svg.innerHTML = `
			<defs>
				<marker id="tws-tour-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M0,0 L10,5 L0,10 z" fill="rgba(122,162,255,.95)"/>
				</marker>
			</defs>
			<line class="tws-tour-beam__line" stroke="rgba(122,162,255,.9)" stroke-width="2.5" stroke-dasharray="2 7" stroke-linecap="round" marker-end="url(#tws-tour-arrow)"/>
		`;
		document.body.appendChild(svg);
		this._beam = svg;
		this._beamLine = svg.querySelector('.tws-tour-beam__line');
	}

	_startBeam() {
		if (this._beamActive) return;
		this._beamActive = true;
		this._beam.style.opacity = '1';
		const tick = () => {
			if (!this._beamActive) return;
			const rect = this.spotlight.getRect();
			const head = this.avatar.headScreen();
			if (rect && head) {
				// Aim at the nearest edge of the feature, not dead-center, so the
				// arrow lands on the box rather than burying itself inside it.
				const tx = clamp(head.x, rect.left, rect.left + rect.width);
				const ty = clamp(head.y, rect.top, rect.top + rect.height);
				this._beamLine.setAttribute('x1', head.x);
				this._beamLine.setAttribute('y1', head.y);
				this._beamLine.setAttribute('x2', tx);
				this._beamLine.setAttribute('y2', ty);
			}
			this._beamRaf = requestAnimationFrame(tick);
		};
		this._beamRaf = requestAnimationFrame(tick);
	}

	_stopBeam() {
		this._beamActive = false;
		cancelAnimationFrame(this._beamRaf);
		if (this._beam) this._beam.style.opacity = '0';
	}

	// ── Misc ──────────────────────────────────────────────────────────────────
	_syncControls() {
		const stop = this.curriculum.stops[this.index];
		this.controls.update({
			chapter: sectionTitle(this.curriculum, stop.section),
			index: this.pos,
			total: this.playlist.length,
		});
	}

	_navigate(path) {
		// Progress is already persisted; the new page's bootstrap calls resume().
		this.config.navigate(path);
	}

	_onKey(e) {
		if (this.panel?.open) return; // the panel owns the keyboard while it's up
		if (isTypingTarget(e.target)) return;
		if (e.key === ' ' || e.key === 'k') {
			e.preventDefault();
			this._togglePause();
		} else if (e.key === 'ArrowRight') {
			this._go(this.pos + 1);
		} else if (e.key === 'ArrowLeft') {
			this._go(this.pos - 1);
		} else if (e.key === 'm' || e.key === 'M') {
			this._toggleMute();
		} else if (e.key === 'c' || e.key === 'C') {
			this.panel?.toggle();
		} else if (e.key === 'r' || e.key === 'R') {
			this._toggleRoam();
		} else if (e.key === 'Escape') {
			if (this.roam) this._exitRoam();
			else this.exit();
		}
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────
function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}
function rectOf(el) {
	const r = el.getBoundingClientRect();
	return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}
function isVisible(el) {
	if (!el || !el.isConnected) return false;
	const r = el.getBoundingClientRect();
	if (r.width < 4 || r.height < 4) return false;
	const style = getComputedStyle(el);
	return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}
function isTypingTarget(el) {
	if (!el) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
function escHtml(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
function escAttr(s) {
	return escHtml(s);
}

let _doneStyles = false;
function ensureDoneStyles() {
	if (_doneStyles) return;
	_doneStyles = true;
	const style = document.createElement('style');
	style.textContent = `
.tws-tour-done{position:fixed;inset:0;z-index:2147483500;display:grid;place-items:center;background:rgba(6,8,12,.6);backdrop-filter:blur(6px);opacity:0;transition:opacity .35s ease;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.tws-tour-done.is-in{opacity:1}
.tws-tour-done__inner{background:#11141c;border:1px solid rgba(122,162,255,.25);border-radius:20px;padding:28px 30px;max-width:380px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.5)}
.tws-tour-done__title{font-size:22px;font-weight:700;color:#f2f4f8;margin-bottom:8px}
.tws-tour-done__body{color:#aeb6c6;font-size:14px;line-height:1.5;margin:0 0 20px}
.tws-tour-done__actions{display:flex;flex-direction:column;gap:10px}
.tws-tour-done__btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#eef1f6;padding:11px 16px;border-radius:11px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;display:block;transition:background .18s ease,border-color .18s ease}
.tws-tour-done__btn:hover{background:rgba(255,255,255,.1)}
.tws-tour-done__btn--primary{background:linear-gradient(90deg,#7aa2ff,#9d7bff);color:#0b0e16;border-color:transparent}
.tws-tour-done__btn--primary:hover{filter:brightness(1.06)}
`;
	document.head.appendChild(style);
}
