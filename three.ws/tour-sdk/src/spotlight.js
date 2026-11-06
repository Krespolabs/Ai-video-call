// spotlight.js — dim the page and ring the element the guide is pointing at.
// A single transparent "hole" element casts a huge box-shadow over everything
// else, so the highlighted feature stays lit while the rest recedes. The hole
// tracks the target every frame (scroll, resize, layout shifts) and exposes its
// live rect so the avatar and the pointer beam can aim at it.

const Z_BACKDROP = 2147483100;

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'tws-tour-spotlight-style';
	style.textContent = `
.tws-tour-spot{position:fixed;z-index:${Z_BACKDROP};border-radius:12px;pointer-events:none;
	box-shadow:0 0 0 9999px rgba(8,10,16,.62),0 0 0 2px rgba(122,162,255,.9),0 0 28px 6px rgba(122,162,255,.55) inset;
	transition:left .45s cubic-bezier(.4,0,.2,1),top .45s cubic-bezier(.4,0,.2,1),width .45s cubic-bezier(.4,0,.2,1),height .45s cubic-bezier(.4,0,.2,1),opacity .3s ease;
	opacity:0}
.tws-tour-spot.is-in{opacity:1}
.tws-tour-spot::after{content:'';position:absolute;inset:-2px;border-radius:14px;border:2px solid rgba(122,162,255,.55);animation:tws-tour-pulse 1.8s ease-in-out infinite}
@keyframes tws-tour-pulse{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.012);opacity:.25}}
@media (prefers-reduced-motion:reduce){.tws-tour-spot{transition:opacity .2s ease}.tws-tour-spot::after{animation:none}}
`;
	document.head.appendChild(style);
}

export class Spotlight {
	constructor() {
		ensureStyles();
		this.el = document.createElement('div');
		this.el.className = 'tws-tour-spot';
		this.el.setAttribute('aria-hidden', 'true');
		document.body.appendChild(this.el);
		this.target = null;
		this._raf = 0;
		this._rect = null;
		this._track = this._track.bind(this);
	}

	// Highlight an element. Pass null to fade the spotlight out (whole-page stop).
	async highlight(el) {
		this.target = el || null;
		if (!el) {
			this.el.classList.remove('is-in');
			this._rect = null;
			return;
		}
		await scrollIntoViewIfNeeded(el);
		this._track();
		this.el.classList.add('is-in');
		if (!this._raf) this._raf = requestAnimationFrame(this._track);
	}

	_track() {
		this._raf = 0;
		const el = this.target;
		if (!el || !el.isConnected) {
			this.el.classList.remove('is-in');
			this._rect = null;
			return;
		}
		const r = el.getBoundingClientRect();
		// Ignore zero-size / off-screen elements (e.g. display:none mid-tour).
		if (r.width < 1 && r.height < 1) {
			this.el.classList.remove('is-in');
		} else {
			const pad = 8;
			const left = Math.max(0, r.left - pad);
			const top = Math.max(0, r.top - pad);
			const width = Math.min(window.innerWidth, r.right + pad) - left;
			const height = Math.min(window.innerHeight, r.bottom + pad) - top;
			this.el.style.left = left + 'px';
			this.el.style.top = top + 'px';
			this.el.style.width = width + 'px';
			this.el.style.height = height + 'px';
			this.el.classList.add('is-in');
			this._rect = { left, top, width, height, cx: left + width / 2, cy: top + height / 2 };
		}
		this._raf = requestAnimationFrame(this._track);
	}

	// Live viewport rect of the current highlight, or null.
	getRect() {
		return this._rect;
	}

	clear() {
		this.target = null;
		this._rect = null;
		this.el.classList.remove('is-in');
	}

	dispose() {
		cancelAnimationFrame(this._raf);
		this.el?.remove();
	}
}

function scrollIntoViewIfNeeded(el) {
	return new Promise((resolve) => {
		const r = el.getBoundingClientRect();
		const fullyVisible = r.top >= 64 && r.bottom <= window.innerHeight - 64;
		if (fullyVisible) {
			resolve();
			return;
		}
		const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		el.scrollIntoView({
			behavior: reduced ? 'auto' : 'smooth',
			block: 'center',
			inline: 'nearest',
		});
		// Resolve after the smooth-scroll settles (or immediately if reduced).
		setTimeout(resolve, reduced ? 0 : 480);
	});
}
