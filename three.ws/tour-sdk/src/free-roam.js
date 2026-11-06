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

// Elements whose clicks belong to the page, never to "walk there".
const INTERACTIVE = 'a,button,input,textarea,select,label,summary,[role="button"],[contenteditable],[contenteditable="true"],canvas,video,iframe,[data-walk-block]';

export function isInteractiveTarget(el) {
	return !!(el && el.closest && el.closest(INTERACTIVE));
}

export class FreeRoam {
	constructor(avatar) {
		this.avatar = avatar;
		this.enabled = false;
		this.dragging = false;
		this._grab = { x: 0, y: 0 };
		this._ptr = { x: 0, y: 0 };
		this._scrollRaf = 0;
		this._reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		this._onDown = this._onDown.bind(this);
		this._onMove = this._onMove.bind(this);
		this._onUp = this._onUp.bind(this);
		ensureStyles();
	}

	enable() {
		if (this.enabled) return;
		this.enabled = true;
		this.avatar.setInteractive(true);
		document.addEventListener('pointerdown', this._onDown, true);
		this._hint = makeHint();
	}

	disable() {
		if (!this.enabled) return;
		this.enabled = false;
		this._endDrag();
		document.removeEventListener('pointerdown', this._onDown, true);
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
		document.removeEventListener('pointermove', this._onMove, true);
		document.removeEventListener('pointerup', this._onUp, true);
		document.removeEventListener('pointercancel', this._onUp, true);
		this.avatar.settle();
	}

	// While dragging near the top/bottom edge, scroll the page and keep the guide
	// pinned under the pointer so it appears to walk the document up/down.
	_startScrollLoop() {
		if (this._reduced) return;
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
		'<span class="tws-roam-hint__dot"></span>Free roam — click anywhere to walk me there, or drag me around. Press ▶ to rejoin the tour.';
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
