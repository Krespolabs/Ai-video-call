// guide-avatar.js — the tour guide's body. A small, always-on-top 3D avatar
// that walks across the viewport to stand beside whatever the tour is showing,
// turns to face it, gestures at it, and carries a speech bubble above its head.
//
// It reuses the published @three-ws/walk avatar loader (loadWalkAvatar) so the
// guide is the same rig family the Walk Companion drives and can never freeze in
// a bind/T-pose, and the same simple controller surface — setState('walk' |
// 'idle') + playWave() — drives the walk-in and the point gesture. By default it
// reads the visitor's chosen companion avatar (config.avatarStorageKey), so the
// guide matches whoever they walk with; otherwise it loads config.guideAvatarId.

import {
	AmbientLight,
	Box3,
	Timer,
	DirectionalLight,
	Group,
	HemisphereLight,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
} from 'three';
import { loadWalkAvatar, resolveConfig, resolveAvatarEntry } from '@three-ws/walk';

const CANVAS_W = 168;
const CANVAS_H = 240;
const MARGIN = 16;
const Z_AVATAR = 2147483300;

// Locomotion is tuned in real-world m/s — like the walk world (src/walk.js) — and
// converted to on-screen px/second at runtime using the avatar's measured
// pixels-per-meter (see _frame). This lets the walk clip's playback rate be scaled
// to actual travel so the feet plant instead of skating: at ~85 px/m a naive
// 460 px/s glide is ~5.4 m/s (a sprint) against a clip authored for 1.5 m/s, which
// is exactly the mismatch that made the guide moon-walk.
//   WALK_MPS/RUN_MPS  — target ground speeds; NATURAL_* — the shared clips' authored
//   ground speed at timeScale 1 (same numbers/clip as src/walk.js). The playback
//   timeScale is target ÷ natural, so stride cadence tracks travel by construction.
const WALK_MPS = 2.7;
const RUN_MPS = 4.2;
const NATURAL_WALK_MPS = 1.5;
const NATURAL_RUN_MPS = 3.4;
const WALK_TIMESCALE = WALK_MPS / NATURAL_WALK_MPS;
const RUN_TIMESCALE = RUN_MPS / NATURAL_RUN_MPS;
// Fallback screen pace (px/s) used only until the avatar is framed and its real
// pixels-per-meter is known — then _walkPx/_runPx take over.
const WALK_SPEED = 200;

// Gravity, mirrored from the walk platformer so the guide obeys the same physics
// the visitor sees there: it falls onto the ground plane and stays planted,
// never floating mid-air. SPAWN_DROP is how far above the floor the guide spawns
// so it visibly settles when it first appears.
const GRAVITY = -14;
const SPAWN_DROP = 0.32;

// How snappily the guide's facing follows its movement direction, mirrored from
// the walk world's TURN_LERP (src/walk.js) so the tour guide turns with the same
// weight as the walk/stroll robot.
const TURN_LERP = 0.18;

export class GuideAvatar {
	constructor(tourConfig = {}) {
		// Feed the host's avatar settings into the walk SDK's config resolver, which
		// gives us the roster, the default avatar entry, and the storage keys.
		this.config = resolveConfig({
			assetBase: tourConfig.assetBase || '',
			apiBase: tourConfig.apiBase || '',
			manifestUrl: tourConfig.manifestUrl || '/animations/manifest.json',
			defaultAvatarId: tourConfig.guideAvatarId || 'realistic-female',
		});
		// Which avatar the guide adopts: the visitor's saved companion choice if
		// present, else the configured guide default.
		this.avatarStorageKey = tourConfig.avatarStorageKey || this.config.keys.avatar;
		this.host = null;
		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.rig = null;
		this.model = null;
		this.controller = null;
		this.clock = null;
		this._raf = 0;
		// Screen travel pace in px/s, derived from the avatar's on-screen scale in
		// _frame; the fallback holds until the first framing measures it.
		this._pxPerMeter = 0;
		this._walkPx = WALK_SPEED;
		this._runPx = WALK_SPEED * (RUN_MPS / WALK_MPS);
		this._yaw = 0;
		this._targetYaw = 0;
		this._walking = false;
		this._walkRaf = 0;
		this._reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		this._pos = { x: 0, y: 0 };
		// Vertical physics state — height above the ground plane and its velocity.
		// Gravity in _tick pulls _y down to 0 and holds it there (see GRAVITY).
		this._groundY = 0;
		this._y = 0;
		this._vy = 0;
		this._tick = this._tick.bind(this);
	}

	async mount() {
		ensureStyles();
		this._buildDom();
		// The DOM host (and its speech bubble) is built first, so even if WebGL or
		// the avatar GLB fail to load the tour degrades gracefully: captions still
		// show above the moving host, and the spotlight + pointer beam still work.
		// The guide just loses its rendered body rather than breaking the tour.
		try {
			await this._buildScene();
			this.clock = new Timer();
			this._raf = requestAnimationFrame(this._tick);
		} catch (err) {
			console.warn('[tour] guide avatar failed to load — continuing without a rendered body:', err?.message || err);
			this._headless = true;
			this.canvas?.remove();
		}
		// Park bottom-right until the first stop moves it.
		const start = { x: window.innerWidth - CANVAS_W - MARGIN, y: window.innerHeight - CANVAS_H - MARGIN };
		this._setPos(start);
	}

	_buildDom() {
		const host = document.createElement('div');
		host.className = 'tws-tour-guide';
		host.setAttribute('role', 'complementary');
		host.setAttribute('aria-label', 'Tour guide');
		host.innerHTML = `
			<div class="tws-tour-guide__bubble" hidden></div>
			<canvas class="tws-tour-guide__canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
		`;
		document.body.appendChild(host);
		this.host = host;
		this.canvas = host.querySelector('.tws-tour-guide__canvas');
		this.bubble = host.querySelector('.tws-tour-guide__bubble');
		requestAnimationFrame(() => host.classList.add('is-in'));
	}

	async _buildScene() {
		const renderer = new WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
		renderer.setSize(CANVAS_W, CANVAS_H, false);
		this.renderer = renderer;

		const scene = new Scene();
		this.scene = scene;
		scene.add(new AmbientLight(0xffffff, 0.9));
		const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.7);
		hemi.position.set(0, 4, 0);
		scene.add(hemi);
		const sun = new DirectionalLight(0xffffff, 1.6);
		sun.position.set(2, 5, 4);
		scene.add(sun);

		this.camera = new PerspectiveCamera(40, CANVAS_W / CANVAS_H, 0.05, 100);
		this.rig = new Group();
		scene.add(this.rig);

		const savedId = lsGet(this.avatarStorageKey) || this.config.defaultAvatarId;
		const entry = resolveAvatarEntry(savedId, this.config);
		const fallback = resolveAvatarEntry(this.config.defaultAvatarId, this.config);
		const { model, controller } = await loadWalkAvatar(entry, {
			assetBase: this.config.assetBase,
			apiBase: this.config.apiBase,
			manifestUrl: this.config.manifestUrl,
			fallbackEntry: fallback,
		});
		this.model = model;
		this.controller = controller;
		this._frame(model, this.rig, this.camera);
	}

	_frame(model, rig, camera) {
		const box = new Box3().setFromObject(model);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		model.position.x -= center.x;
		model.position.z -= center.z;
		model.position.y -= box.min.y;
		rig.add(model);
		const height = Math.max(0.6, size.y);
		camera.position.set(0, height * 0.62, height * 2.2);
		camera.lookAt(0, height * 0.52, 0);
		// Measure how many on-screen pixels one world meter spans at the avatar's
		// depth, so px/s travel can be tied to the clip's m/s cadence. The visible
		// world height at the look-at distance maps to the displayed canvas height
		// (getBoundingClientRect, so CSS-scaled mobile sizing is handled too).
		const camDist = camera.position.distanceTo(new Vector3(0, height * 0.52, 0));
		const visibleWorldH = 2 * camDist * Math.tan((camera.fov * Math.PI) / 180 / 2);
		const displayH = this.size().h || CANVAS_H;
		this._pxPerMeter = visibleWorldH > 0 ? displayH / visibleWorldH : 0;
		if (this._pxPerMeter > 0) {
			this._walkPx = WALK_MPS * this._pxPerMeter;
			this._runPx = RUN_MPS * this._pxPerMeter;
		}
		// Feet rest at rig-local y = 0; gravity in _tick drives rig.position.y down
		// to the ground plane. Spawn a touch above it so the guide drops and settles
		// onto the floor when it first appears — the same fall the walk platformer
		// applies. Honour reduced-motion by starting already grounded.
		this._y = this._reduced ? this._groundY : this._groundY + SPAWN_DROP;
		this._vy = 0;
		rig.position.y = this._y;
	}

	// ── Public choreography API ───────────────────────────────────────────────

	// Walk the avatar to a screen position (top-left of its canvas). Resolves
	// when it arrives. Rather than gliding via a CSS transition, it steps the
	// guide there frame-by-frame at a constant pace through place() — the exact
	// locomotion the visitor drives in free roam — so the body advances in
	// lockstep with the walk cycle and reads as genuine walking, not a slide.
	walkTo(pos) {
		const clamped = {
			x: clamp(pos.x, MARGIN, window.innerWidth - CANVAS_W - MARGIN),
			y: clamp(pos.y, MARGIN, window.innerHeight - CANVAS_H - MARGIN),
		};
		// Supersede any walk already in flight so a fresh click redirects the guide.
		cancelAnimationFrame(this._walkRaf);
		this._walkRaf = 0;
		const dx = clamped.x - this._pos.x;
		const dy = clamped.y - this._pos.y;
		const dist = Math.hypot(dx, dy);
		if (dist < 4 || this._reduced) {
			// Already there, or reduced-motion: place without a stride and settle.
			this._setPos(clamped);
			this.settle();
			return Promise.resolve();
		}
		const ux = dx / dist;
		const uy = dy / dist;
		const from = { x: this._pos.x, y: this._pos.y };
		let traveled = 0;
		let last = performance.now();
		return new Promise((resolve) => {
			const step = (now) => {
				const dt = Math.min((now - last) / 1000, 0.05);
				last = now;
				traveled = Math.min(dist, traveled + (this._walkPx || WALK_SPEED) * dt);
				this.place({ x: from.x + ux * traveled, y: from.y + uy * traveled });
				if (traveled >= dist) {
					this._walkRaf = 0;
					this.settle();
					resolve();
					return;
				}
				this._walkRaf = requestAnimationFrame(step);
			};
			this._walkRaf = requestAnimationFrame(step);
		});
	}

	// Compute a resting spot beside a target rect (viewport coords), preferring
	// whichever side has room, and walk there + turn to face the target.
	async approach(rect) {
		const pos = this._spotBeside(rect);
		await this.walkTo(pos);
		this._faceRect(rect);
	}

	// Park in a neutral corner and face forward (whole-page stops).
	async park() {
		await this.walkTo({
			x: window.innerWidth - CANVAS_W - MARGIN,
			y: window.innerHeight - CANVAS_H - MARGIN,
		});
		this._targetYaw = 0;
	}

	// Point at the current target: a wave-style gesture toward it.
	point() {
		this.controller?.playWave();
	}

	// ── Free-roam hooks ─────────────────────────────────────────────────────────
	// The canvas host is pointer-events:none during the guided tour so it never
	// eats page clicks; free-roam flips it interactive so the guide can be grabbed.
	setInteractive(on) {
		if (!this.host) return;
		this.host.style.pointerEvents = on ? 'auto' : 'none';
		this.host.classList.toggle('is-roam', !!on);
	}

	// Footprint of the avatar host, for centering it under a pointer.
	size() {
		const r = this.host?.getBoundingClientRect();
		return { w: r?.width || CANVAS_W, h: r?.height || CANVAS_H };
	}

	// Instant placement (drag / edge-scroll follow): clamp to the viewport, face
	// the direction of travel, run the walk cycle, and auto-settle to idle shortly
	// after movement stops so a parked guide isn't stuck mid-stride.
	place(pos) {
		const s = this.size();
		const x = clamp(pos.x, MARGIN, window.innerWidth - s.w - MARGIN);
		const y = clamp(pos.y, MARGIN, window.innerHeight - s.h - MARGIN);
		const dx = x - this._pos.x;
		const dy = y - this._pos.y;
		// Full 360° facing from the actual travel vector — the same omnidirectional
		// turn the walk/stroll robot uses (src/walk.js: yaw = atan2(moveX, moveZ)).
		// Screen +x maps to world +X (right); screen +y (downward, toward the viewer)
		// maps to world +Z (toward the fixed front camera, the rig's yaw=0 forward),
		// so atan2(dx, dy) turns the guide to face wherever it walks — left, right,
		// toward the camera, or away — instead of the old ±40° horizontal tilt.
		if (Math.hypot(dx, dy) > 1) this._targetYaw = Math.atan2(dx, dy);
		this.controller?.setState('walk');
		// Match clip cadence to travel so the stride ground-speed equals the body's
		// and the feet plant (the walk world's mixer.timeScale = speed/natural trick).
		this.controller?.setSpeed?.(WALK_TIMESCALE);
		this._walking = true;
		clearTimeout(this._settleTimer);
		this._settleTimer = setTimeout(() => this.settle(), 180);
		this._setPos({ x, y });
	}

	settle() {
		clearTimeout(this._settleTimer);
		this._walking = false;
		this._targetYaw = 0;
		this.controller?.setState('idle');
		this.controller?.setSpeed?.(1); // idle plays at its authored cadence
	}

	_spotBeside(rect) {
		const gap = 22;
		const rightX = rect.left + rect.width + gap;
		const leftX = rect.left - CANVAS_W - gap;
		let x;
		if (rightX + CANVAS_W <= window.innerWidth - MARGIN) x = rightX;
		else if (leftX >= MARGIN) x = leftX;
		else x = clamp(rect.cx - CANVAS_W / 2, MARGIN, window.innerWidth - CANVAS_W - MARGIN);
		const y = clamp(rect.cy - CANVAS_H * 0.58, MARGIN, window.innerHeight - CANVAS_H - MARGIN);
		return { x, y };
	}

	_faceRect(rect) {
		const avatarCx = this._pos.x + CANVAS_W / 2;
		const avatarCy = this._pos.y + CANVAS_H / 2;
		// Turn to fully face the highlighted target, matching the walk robot's
		// all-directions facing rather than the old ±34° horizontal clamp. Same
		// screen→world axis mapping as place() (dx→X, dy→Z toward the camera).
		this._targetYaw = Math.atan2(rect.cx - avatarCx, rect.cy - avatarCy);
	}

	// Approximate screen position of the avatar's head — origin for the pointer
	// beam the director draws to the highlighted element.
	headScreen() {
		return { x: this._pos.x + CANVAS_W / 2, y: this._pos.y + CANVAS_H * 0.18 };
	}

	// ── Speech bubble ─────────────────────────────────────────────────────────
	say(text) {
		if (!this.bubble) return;
		this.bubble.textContent = text;
		this.bubble.hidden = false;
		requestAnimationFrame(() => this.bubble.classList.add('is-in'));
	}
	hideBubble() {
		if (!this.bubble) return;
		this.bubble.classList.remove('is-in');
		setTimeout(() => {
			if (this.bubble) this.bubble.hidden = true;
		}, 280);
	}

	// ── Internals ─────────────────────────────────────────────────────────────
	// Snap the host to a screen position. All locomotion is now driven frame-by-
	// frame (walkTo / place / free-roam), so the host never CSS-transitions — its
	// stride and travel stay in sync.
	_setPos(pos) {
		this._pos = pos;
		if (!this.host) return;
		this.host.style.left = pos.x + 'px';
		this.host.style.top = pos.y + 'px';
	}

	_tick() {
		if (!this.host) return;
		this.clock.update();
		const dt = Math.min(this.clock.getDelta(), 0.05);
		// Shortest-arc turn toward the target facing. With full 360° targets the
		// naïve (target - current) lerp would spin the long way across the ±π seam;
		// wrapping the delta into [-π, π] keeps every turn taking the near side.
		this._yaw += shortestAngle(this._targetYaw - this._yaw) * TURN_LERP;
		if (this.rig) {
			this.rig.rotation.y = this._yaw;
			// Gravity: integrate velocity, land on the ground plane, hold there —
			// the same model the walk platformer uses so the guide is never airborne.
			this._vy += GRAVITY * dt;
			this._y += this._vy * dt;
			if (this._y <= this._groundY) {
				this._y = this._groundY;
				if (this._vy < 0) this._vy = 0;
			}
			this.rig.position.y = this._y;
		}
		this.controller?.update(dt);
		this.renderer.render(this.scene, this.camera);
		this._raf = requestAnimationFrame(this._tick);
	}

	dispose() {
		cancelAnimationFrame(this._raf);
		cancelAnimationFrame(this._walkRaf);
		clearTimeout(this._settleTimer);
		this._raf = 0;
		this._walkRaf = 0;
		try {
			this.controller?.dispose();
		} catch {
			/* non-fatal */
		}
		if (this.scene) {
			this.scene.traverse((n) => {
				if (n.isMesh) disposeMesh(n);
			});
		}
		if (this.renderer) {
			this.renderer.dispose();
			this.renderer.forceContextLoss?.();
		}
		this.host?.remove();
		this.host = null;
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────
function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}
// Wrap an angle delta into [-π, π] so a yaw lerp always rotates the short way.
function shortestAngle(d) {
	return Math.atan2(Math.sin(d), Math.cos(d));
}
function lsGet(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function disposeMesh(n) {
	n.geometry?.dispose?.();
	const mats = Array.isArray(n.material) ? n.material : [n.material];
	mats.forEach((m) => {
		if (!m) return;
		for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
		m.dispose?.();
	});
}

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'tws-tour-guide-style';
	style.textContent = `
.tws-tour-guide{position:fixed;left:0;top:0;width:${CANVAS_W}px;height:${CANVAS_H}px;z-index:${Z_AVATAR};pointer-events:none;opacity:0;transform:translateY(10px);transition:opacity .4s ease,transform .4s ease;-webkit-user-select:none;user-select:none}
.tws-tour-guide.is-in{opacity:1;transform:translateY(0)}
.tws-tour-guide__canvas{position:absolute;inset:0;width:100%;height:100%;filter:drop-shadow(0 16px 20px rgba(0,0,0,.34))}
.tws-tour-guide__bubble{position:absolute;left:50%;bottom:calc(100% - 30px);transform:translateX(-50%) translateY(8px);width:max-content;max-width:320px;background:rgba(18,20,28,.96);color:#f2f4f8;font:500 13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;padding:10px 13px;border-radius:14px;border:1px solid rgba(122,162,255,.28);box-shadow:0 12px 30px rgba(0,0,0,.4);opacity:0;transition:opacity .3s ease,transform .3s ease;text-align:left}
.tws-tour-guide__bubble.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.tws-tour-guide__bubble::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:7px solid transparent;border-top-color:rgba(18,20,28,.96)}
@media (max-width:560px){.tws-tour-guide{width:128px;height:182px}.tws-tour-guide__bubble{max-width:230px;font-size:12px}}
@media (prefers-reduced-motion:reduce){.tws-tour-guide,.tws-tour-guide__bubble{transition:opacity .2s ease}}
`;
	document.head.appendChild(style);
}
