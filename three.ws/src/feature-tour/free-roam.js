// free-roam.js — hand the stage to the visitor. When the guided tour is paused
// into "free roam", this lets you drive the guide around the page yourself:
//   · Click any empty patch of the page → the guide walks there.
//   · Grab the guide and drag it anywhere.
//   · Drag it to the top or bottom edge → the page scrolls under it, so you can
//     walk it up and down the whole document, not just the current viewport.
// It reuses the GuideAvatar's own walk choreography (walkTo / place / settle),
// so the rig animates and faces its heading exactly as it does on the tour.
//
// Activation mirrors the corner companion's click-to-walk contract: we listen in
// the capture phase but only ever act on empty space (never links, buttons,
// inputs, canvases or [data-walk-block]) and never call preventDefault on a real
// page interaction — so normal clicking is provably untouched. Dragging the
// guide itself does preventDefault, because the guide has no page behaviour to
// preserve.

const EDGE = 96; // px band at top/bottom of the viewport that auto-scrolls
const SCROLL_MAX = 22; // px per frame at the very edge
const RIPPLE_MS = 600;
const Z_FX = 2147483090; // under the spotlight (…100), over the page

// Keyboard walking — screen-space speeds in px/second, like the Walk playground.
const WALK_SPEED = 460;
const RUN_SPEED = 820;
const MARGIN = 16; // viewport inset the guide stays within (matches GuideAvatar)

function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

// Elements whose clicks belong to the page, never to "walk there".
const INTERACTIVE = 'a,button,input,textarea,select,label,summary,[role="button"],[contenteditable],[contenteditable="true"],canvas,video,iframe,[data-walk-block]';

export function isInteractiveTarget(el) {
	return !!(el && el.closest && el.closest(INTERACTIVE));
}

// A field the visitor is typing into — never steal its keystrokes for walking.
function isTypingTarget(el) {
	if (!el) return false;
	const tag = el.tagName;
	return (
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		tag === 'SELECT' ||
		el.isContentEditable === true
	);
}

export class FreeRoam {
	constructor(avatar) {
		this.avatar = avatar;
		this.enabled = false;
		this.dragging = false;
		this._dragPointerId = null;
		this._grab = { x: 0, y: 0 };
		this._ptr = { x: 0, y: 0 };
		this._scrollRaf = 0;
		this._reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		// Keyboard walking state — held directions + the guide's live screen position.
		this._keys = { up: false, down: false, left: false, right: false, run: false };
		this._walkRaf = 0;
		this._walkPos = null;
		this._walkLast = 0;
		this._onDown = this._onDown.bind(this);
		this._onMove = this._onMove.bind(this);
		this._onUp = this._onUp.bind(this);
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onKeyUp = this._onKeyUp.bind(this);
		this._walkTick = this._walkTick.bind(this);
		ensureStyles();
	}

	enable() {
		if (this.enabled) return;
		this.enabled = true;
		this.avatar.setInteractive(true);
		document.addEventListener('pointerdown', this._onDown, true);
		// Capture phase so movement keys reach the guide before the director's
		// stop-navigation handler, which we silence per-key while walking.
		document.addEventListener('keydown', this._onKeyDown, true);
		document.addEventListener('keyup', this._onKeyUp, true);
		this._hint = makeHint();
	}

	disable() {
		if (!this.enabled) return;
		this.enabled = false;
		this._endDrag();
		this._stopWalk();
		// A key still physically held when we disable will never deliver its keyup
		// here (listeners are about to be removed), which would leave that direction
		// stuck on for the next enable — clear the held state now.
		this._keys = { up: false, down: false, left: false, right: false, run: false };
		document.removeEventListener('pointerdown', this._onDown, true);
		document.removeEventListener('keydown', this._onKeyDown, true);
		document.removeEventListener('keyup', this._onKeyUp, true);
		this.avatar.setInteractive(false);
		this.avatar.settle();
		this._hint?.remove();
		this._hint = null;
	}

	// ── Pointer handling ────────────────────────────────────────────────────────
	_onDown(e) {
		if (!this.enabled || e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
		const host = this.avatar.host;
		if (host && host.contains(e.target)) {
			// Grab the guide itself → drag.
			const r = host.getBoundingClientRect();
			this._grab = { x: e.clientX - r.left, y: e.clientY - r.top };
			this._ptr = { x: e.clientX, y: e.clientY };
			this.dragging = true;
			this._dragPointerId = e.pointerId;
			try {
				host.setPointerCapture(e.pointerId);
			} catch {
				/* capture unsupported / already released — document listeners still cover it */
			}
			document.addEventListener('pointermove', this._onMove, true);
			document.addEventListener('pointerup', this._onUp, true);
			document.addEventListener('pointercancel', this._onUp, true);
			this._startScrollLoop();
			this._dismissHint();
			e.preventDefault();
			return;
		}
		if (isInteractiveTarget(e.target)) return; // leave real page clicks alone
		// Click on empty space → walk the guide there, centered under the click.
		const s = this.avatar.size();
		this.avatar.walkTo({ x: e.clientX - s.w / 2, y: e.clientY - s.h / 2 });
		if (!this._reduced) ripple(e.clientX, e.clientY);
		this._dismissHint();
	}

	_onMove(e) {
		if (!this.dragging) return;
		this._ptr = { x: e.clientX, y: e.clientY };
		this.avatar.place({ x: e.clientX - this._grab.x, y: e.clientY - this._grab.y });
	}

	_onUp() {
		this._endDrag();
	}

	_endDrag() {
		cancelAnimationFrame(this._scrollRaf);
		this._scrollRaf = 0;
		if (!this.dragging) return;
		this.dragging = false;
		if (this._dragPointerId != null) {
			try {
				this.avatar.host?.releasePointerCapture(this._dragPointerId);
			} catch {
				/* already released */
			}
			this._dragPointerId = null;
		}
		document.removeEventListener('pointermove', this._onMove, true);
		document.removeEventListener('pointerup', this._onUp, true);
		document.removeEventListener('pointercancel', this._onUp, true);
		this.avatar.settle();
	}

	// ── Keyboard walking ─────────────────────────────────────────────────────────
	// Drive the guide across the page with WASD / arrow keys (hold Shift to run),
	// exactly like steering your avatar on the Walk pages. Movement is screen-space
	// and pins-and-scrolls at the viewport edges, so you can walk the whole document
	// — not just the current screen. Real page clicks and typing are never touched.
	_dirFor(key) {
		switch (key) {
			case 'ArrowUp':
			case 'w':
			case 'W':
				return 'up';
			case 'ArrowDown':
			case 's':
			case 'S':
				return 'down';
			case 'ArrowLeft':
			case 'a':
			case 'A':
				return 'left';
			case 'ArrowRight':
			case 'd':
			case 'D':
				return 'right';
			default:
				return null;
		}
	}

	_onKeyDown(e) {
		if (!this.enabled || this.dragging) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (isTypingTarget(e.target)) return;
		const dir = this._dirFor(e.key);
		if (!dir) return;
		// Own this key: stop the director from treating arrows as stop-navigation
		// and the browser from scrolling the page out from under the walk.
		e.preventDefault();
		e.stopPropagation();
		this._keys[dir] = true;
		this._keys.run = e.shiftKey;
		this._dismissHint();
		this._startWalk();
	}

	_onKeyUp(e) {
		if (e.key === 'Shift') this._keys.run = false;
		const dir = this._dirFor(e.key);
		if (!dir) return;
		e.stopPropagation();
		this._keys[dir] = false;
		if (!this._keys.up && !this._keys.down && !this._keys.left && !this._keys.right) {
			this._stopWalk();
		}
	}

	_startWalk() {
		if (this._walkRaf) return;
		const r = this.avatar.host?.getBoundingClientRect();
		this._walkPos = { x: r?.left ?? this._ptr.x, y: r?.top ?? this._ptr.y };
		this._walkLast = performance.now();
		this._walkRaf = requestAnimationFrame(this._walkTick);
	}

	_stopWalk() {
		cancelAnimationFrame(this._walkRaf);
		this._walkRaf = 0;
		this._walkPos = null;
		if (this.enabled && !this.dragging) this.avatar.settle();
	}

	_walkTick(now) {
		if (!this.enabled || this.dragging) {
			this._walkRaf = 0;
			return;
		}
		const dt = Math.min((now - this._walkLast) / 1000, 0.05);
		this._walkLast = now;

		let ix = (this._keys.right ? 1 : 0) - (this._keys.left ? 1 : 0);
		let iy = (this._keys.down ? 1 : 0) - (this._keys.up ? 1 : 0);
		if (ix === 0 && iy === 0) {
			this._stopWalk();
			return;
		}
		if (ix !== 0 && iy !== 0) {
			const inv = 1 / Math.SQRT2;
			ix *= inv;
			iy *= inv;
		}
		const speed = this._keys.run ? RUN_SPEED : WALK_SPEED;
		const s = this.avatar.size();
		const maxX = window.innerWidth - s.w - MARGIN;
		const maxY = window.innerHeight - s.h - MARGIN;

		this._walkPos.x = clamp(this._walkPos.x + ix * speed * dt, MARGIN, maxX);

		// Vertical: walk within the viewport; at the top/bottom edge, pin the guide
		// and scroll the document instead so the walk continues down the whole page.
		let rawY = this._walkPos.y + iy * speed * dt;
		if (rawY < MARGIN && iy < 0) {
			window.scrollBy(0, rawY - MARGIN);
			rawY = MARGIN;
		} else if (rawY > maxY && iy > 0) {
			window.scrollBy(0, rawY - maxY);
			rawY = maxY;
		}
		this._walkPos.y = clamp(rawY, MARGIN, maxY);

		this.avatar.place({ x: this._walkPos.x, y: this._walkPos.y }, { running: this._keys.run });
		this._walkRaf = requestAnimationFrame(this._walkTick);
	}

	// While dragging near the top/bottom edge, scroll the page and keep the guide
	// pinned under the pointer so it appears to walk the document up/down.
	_startScrollLoop() {
		const tick = () => {
			if (!this.dragging) return;
			const y = this._ptr.y;
			const h = window.innerHeight;
			let dy = 0;
			if (y < EDGE) dy = -SCROLL_MAX * (1 - y / EDGE);
			else if (y > h - EDGE) dy = SCROLL_MAX * (1 - (h - y) / EDGE);
			if (dy) {
				window.scrollBy(0, dy);
				this.avatar.place({ x: this._ptr.x - this._grab.x, y: this._ptr.y - this._grab.y });
			}
			this._scrollRaf = requestAnimationFrame(tick);
		};
		this._scrollRaf = requestAnimationFrame(tick);
	}

	_dismissHint() {
		if (!this._hint) return;
		this._hint.classList.remove('is-in');
		const el = this._hint;
		this._hint = null;
		setTimeout(() => el.remove(), 300);
	}
}

// ── FX ─────────────────────────────────────────────────────────────────────────
function ripple(x, y) {
	const r = document.createElement('div');
	r.className = 'tws-roam-ripple';
	r.style.left = x + 'px';
	r.style.top = y + 'px';
	document.body.appendChild(r);
	setTimeout(() => r.remove(), RIPPLE_MS);
}

function makeHint() {
	const h = document.createElement('div');
	h.className = 'tws-roam-hint';
	h.setAttribute('role', 'status');
	h.innerHTML =
		'<span class="tws-roam-hint__dot"></span>Free roam — walk me with WASD / arrow keys (Shift to run), click anywhere to send me there, or drag me. Press ▶ to rejoin the tour.';
	document.body.appendChild(h);
	requestAnimationFrame(() => h.classList.add('is-in'));
	return h;
}

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'tws-tour-roam-style';
	style.textContent = `
.tws-tour-guide.is-roam{pointer-events:auto;cursor:grab}
.tws-tour-guide.is-roam:active{cursor:grabbing}
.tws-roam-ripple{position:fixed;z-index:${Z_FX};width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid rgba(122,162,255,.9);pointer-events:none;animation:tws-roam-ripple ${RIPPLE_MS}ms ease-out forwards}
@keyframes tws-roam-ripple{0%{transform:scale(.4);opacity:.9}100%{transform:scale(3.4);opacity:0}}
.tws-roam-hint{position:fixed;left:50%;top:18px;transform:translateX(-50%) translateY(-12px);z-index:${Z_FX};display:flex;align-items:center;gap:9px;max-width:min(560px,92vw);padding:10px 16px;background:rgba(14,16,22,.94);backdrop-filter:blur(10px);border:1px solid rgba(122,162,255,.3);border-radius:99px;color:#e7eaf2;font:600 13px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.45);opacity:0;transition:opacity .3s ease,transform .3s ease;pointer-events:none}
.tws-roam-hint.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.tws-roam-hint__dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#7aa2ff,#9d7bff);box-shadow:0 0 10px rgba(122,162,255,.8);flex:0 0 auto}
@media (prefers-reduced-motion:reduce){.tws-roam-hint{transition:opacity .2s ease}.tws-roam-ripple{display:none}}
`;
	document.head.appendChild(style);
}
