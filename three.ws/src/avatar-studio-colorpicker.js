/**
 * Avatar Studio — advanced color picker popover
 *
 * A full-spectrum HSV picker that augments the fixed swatch grid in the Color
 * tab.  Built on iro.js (MPL-2.0, lazy-loaded so it never weighs down first
 * paint) and wired to the same live-preview / commit path the swatches use:
 *
 *   - onInput(hex)   → live, fires continuously while dragging (no history)
 *   - onChange(hex)  → commit, fires when a value is settled (pushes history)
 *
 * Extras layered on top of the wheel:
 *   - Hex entry field (type or paste any #rrggbb)
 *   - Native EyeDropper — sample any pixel on screen, where supported
 *   - Recent colors — the last dozen colors picked across the whole studio,
 *     persisted in localStorage so a palette carries between sessions.
 *
 * One popover exists at a time; opening a second closes the first.  Escape and
 * outside-clicks dismiss it, committing whatever color is showing.
 */

import { log } from './shared/log.js';

const RECENT_KEY = 'avatar-studio-recent-colors';
const RECENT_MAX = 12;
const HEX_RE = /^#?[0-9a-f]{6}$/i;

let iroPromise = null;
let activePopover = null;

function loadIro() {
	if (!iroPromise) {
		iroPromise = import('@jaames/iro').then((m) => m.default || m);
	}
	return iroPromise;
}

function normalizeHex(value) {
	if (typeof value !== 'string') return null;
	const v = value.trim();
	if (!HEX_RE.test(v)) return null;
	return (v[0] === '#' ? v : `#${v}`).toLowerCase();
}

// ── Recent colors (shared across slots, persisted) ───────────────────

export function getRecentColors() {
	try {
		const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
		if (!Array.isArray(raw)) return [];
		return raw.map(normalizeHex).filter(Boolean).slice(0, RECENT_MAX);
	} catch {
		return [];
	}
}

export function pushRecentColor(hex) {
	const norm = normalizeHex(hex);
	if (!norm) return;
	const next = [norm, ...getRecentColors().filter((c) => c !== norm)].slice(0, RECENT_MAX);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		/* storage full / blocked — recents are a nicety, never fatal */
	}
}

// ── CSS (injected once) ──────────────────────────────────────────────

let _cssInjected = false;
function ensureCss() {
	if (_cssInjected) return;
	_cssInjected = true;
	const style = document.createElement('style');
	style.textContent = `
		.as-cp {
			position: fixed; z-index: 320;
			width: 244px;
			background: var(--panel, #111);
			border: 1px solid var(--border-2, #2a2a2a);
			border-radius: 14px;
			padding: 14px;
			box-shadow: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02);
			display: flex; flex-direction: column; gap: 12px;
			font-family: inherit;
			opacity: 0; transform: translateY(-6px) scale(0.98);
			transition: opacity .14s ease, transform .14s ease;
		}
		.as-cp.in { opacity: 1; transform: translateY(0) scale(1); }
		.as-cp-head {
			display: flex; align-items: center; justify-content: space-between; gap: 8px;
		}
		.as-cp-title {
			font-size: 12px; font-weight: 600; color: var(--text, #fafafa);
			letter-spacing: .01em;
		}
		.as-cp-close {
			background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a);
			color: var(--text-2, #a1a1aa); width: 24px; height: 24px; border-radius: 999px;
			cursor: pointer; font: inherit; font-size: 13px; line-height: 1;
			display: inline-flex; align-items: center; justify-content: center;
			transition: color .15s, border-color .15s;
		}
		.as-cp-close:hover { color: var(--text, #fafafa); border-color: var(--text-3, #71717a); }
		.as-cp-wheel { display: flex; justify-content: center; }
		.as-cp-row { display: flex; align-items: center; gap: 8px; }
		.as-cp-hex {
			flex: 1; min-width: 0;
			background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a);
			border-radius: 8px; color: var(--text, #fafafa);
			padding: 7px 10px; font: 500 12px/1 ui-monospace, 'SF Mono', monospace;
			letter-spacing: .04em; text-transform: uppercase; outline: none;
			transition: border-color .15s;
		}
		.as-cp-hex:focus { border-color: var(--accent, #fff); }
		.as-cp-hex.bad { border-color: var(--danger, #f43f5e); }
		.as-cp-eye {
			flex-shrink: 0; width: 32px; height: 32px;
			background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a);
			border-radius: 8px; color: var(--text-2, #a1a1aa);
			cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
			transition: color .15s, border-color .15s, background .15s;
		}
		.as-cp-eye:hover { color: var(--text, #fafafa); border-color: var(--text-3, #71717a); background: rgba(255,255,255,.03); }
		.as-cp-eye:focus-visible { box-shadow: 0 0 0 2px var(--accent, #fff); outline: none; }
		.as-cp-recent-label {
			font-size: 9px; text-transform: uppercase; letter-spacing: .08em;
			color: var(--text-3, #71717a); margin-bottom: -4px;
		}
		.as-cp-recent { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
		.as-cp-recent button {
			aspect-ratio: 1/1; border-radius: 7px; border: 1px solid var(--border-2, #2a2a2a);
			cursor: pointer; padding: 0; transition: transform .12s, border-color .12s;
			outline: none;
		}
		.as-cp-recent button:hover { transform: translateY(-1px); border-color: var(--text-3, #71717a); }
		.as-cp-recent button:focus-visible { box-shadow: 0 0 0 2px var(--accent, #fff); }
		.as-cp-empty { font-size: 11px; color: var(--text-3, #71717a); }
		.IroColorPicker { user-select: none; }
	`;
	document.head.appendChild(style);
}

// ── Positioning ──────────────────────────────────────────────────────

function positionPopover(el, anchorEl) {
	const a = anchorEl.getBoundingClientRect();
	const w = el.offsetWidth || 244;
	const h = el.offsetHeight || 300;
	const margin = 8;
	let left = a.left + a.width / 2 - w / 2;
	left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
	// Prefer below the anchor; flip above if it would overflow the viewport.
	let top = a.bottom + margin;
	if (top + h > window.innerHeight - margin) {
		top = Math.max(margin, a.top - h - margin);
	}
	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(top)}px`;
}

// ── Public: open the popover ─────────────────────────────────────────

/**
 * Open the color popover anchored to an element.
 *
 * @param {Object}   opts
 * @param {Element}  opts.anchorEl  element to position against
 * @param {string}   [opts.title]   header label (e.g. "Skin tone")
 * @param {string}   [opts.current] starting hex (#rrggbb)
 * @param {Function} opts.onInput   (hex) => void  — live, no history
 * @param {Function} opts.onChange  (hex) => void  — commit a settled value
 * @param {Function} [opts.onClose] (hex) => void  — fires once when dismissed
 * @returns {Promise<{close:Function}>}
 */
export async function openColorPopover({ anchorEl, title, current, onInput, onChange, onClose }) {
	ensureCss();
	closeActivePopover();

	const startHex = normalizeHex(current) || '#ffffff';
	let lastHex = startHex;

	const el = document.createElement('div');
	el.className = 'as-cp';
	el.setAttribute('role', 'dialog');
	el.setAttribute('aria-label', `${title || 'Custom'} color picker`);
	const hasEyeDropper = typeof window.EyeDropper === 'function';
	el.innerHTML = `
		<div class="as-cp-head">
			<span class="as-cp-title">${escapeHtml(title || 'Custom color')}</span>
			<button type="button" class="as-cp-close" aria-label="Close">×</button>
		</div>
		<div class="as-cp-wheel" data-wheel></div>
		<div class="as-cp-row">
			<input class="as-cp-hex" type="text" inputmode="text" spellcheck="false"
			       maxlength="7" aria-label="Hex color" value="${startHex.toUpperCase()}" />
			${hasEyeDropper ? `<button type="button" class="as-cp-eye" aria-label="Pick a color from the screen" title="Eyedropper">
				<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 0 1 3 3L21 9 18 6"/></svg>
			</button>` : ''}
		</div>
		<div class="as-cp-recent-label">Recent</div>
		<div class="as-cp-recent" data-recent></div>
	`;
	document.body.appendChild(el);

	const hexInput = el.querySelector('.as-cp-hex');
	const wheelHost = el.querySelector('[data-wheel]');

	let cp = null;
	let suppressInput = false; // guard hex-input feedback loops

	const commit = (hex) => {
		const norm = normalizeHex(hex);
		if (!norm) return;
		lastHex = norm;
		pushRecentColor(norm);
		renderRecent();
		onChange?.(norm);
	};

	const setFromHex = (raw, { live = false } = {}) => {
		const norm = normalizeHex(raw);
		if (!norm) {
			hexInput.classList.add('bad');
			return false;
		}
		hexInput.classList.remove('bad');
		lastHex = norm;
		if (cp) {
			suppressInput = true;
			cp.color.hexString = norm;
			suppressInput = false;
		}
		if (live) onInput?.(norm);
		else commit(norm);
		return true;
	};

	hexInput.addEventListener('input', () => {
		// Live-preview valid intermediate values without committing history.
		if (HEX_RE.test(hexInput.value.trim())) setFromHex(hexInput.value, { live: true });
		else hexInput.classList.add('bad');
	});
	hexInput.addEventListener('change', () => setFromHex(hexInput.value));
	hexInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); if (setFromHex(hexInput.value)) hexInput.blur(); }
	});

	const eyeBtn = el.querySelector('.as-cp-eye');
	eyeBtn?.addEventListener('click', async () => {
		try {
			const dropper = new window.EyeDropper();
			const { sRGBHex } = await dropper.open();
			const norm = normalizeHex(sRGBHex);
			if (norm) {
				hexInput.value = norm.toUpperCase();
				setFromHex(norm);
			}
		} catch {
			/* user cancelled the eyedropper — no-op */
		}
	});

	function renderRecent() {
		const host = el.querySelector('[data-recent]');
		const recents = getRecentColors();
		if (!recents.length) {
			host.innerHTML = `<span class="as-cp-empty" style="grid-column:1/-1">Colors you pick appear here.</span>`;
			return;
		}
		host.innerHTML = recents
			.map((hex) => `<button type="button" data-hex="${hex}" style="background:${hex}" aria-label="Use ${hex.toUpperCase()}" title="${hex.toUpperCase()}"></button>`)
			.join('');
		host.querySelectorAll('button[data-hex]').forEach((b) => {
			b.addEventListener('click', () => {
				hexInput.value = b.dataset.hex.toUpperCase();
				setFromHex(b.dataset.hex);
			});
		});
	}
	renderRecent();

	// ── Lifecycle: position, focus, dismiss ──────────────────────────
	positionPopover(el, anchorEl);
	requestAnimationFrame(() => el.classList.add('in'));

	const reposition = () => positionPopover(el, anchorEl);
	window.addEventListener('resize', reposition);
	window.addEventListener('scroll', reposition, true);

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		window.removeEventListener('resize', reposition);
		window.removeEventListener('scroll', reposition, true);
		document.removeEventListener('pointerdown', onOutside, true);
		document.removeEventListener('keydown', onKey, true);
		// Ensure the final shown color is committed (covers wheel-only picks
		// that ended without a dedicated input:end, plus close-by-outside-click).
		commit(lastHex);
		onClose?.(lastHex);
		el.classList.remove('in');
		setTimeout(() => { el.remove(); if (cp) try { cp.off(); } catch { /* ignore */ } }, 150);
		if (activePopover?.el === el) activePopover = null;
		// Return focus to the trigger for keyboard users.
		if (anchorEl && typeof anchorEl.focus === 'function') anchorEl.focus();
	};

	const onOutside = (e) => {
		if (!el.contains(e.target) && e.target !== anchorEl && !anchorEl.contains?.(e.target)) close();
	};
	const onKey = (e) => {
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
	};
	// Defer outside-listener binding so the opening click doesn't close it.
	setTimeout(() => {
		if (closed) return;
		document.addEventListener('pointerdown', onOutside, true);
		document.addEventListener('keydown', onKey, true);
	}, 0);

	el.querySelector('.as-cp-close').addEventListener('click', close);

	activePopover = { el, close };

	// Lazy-build the iro wheel LAST, so the hex field, eyedropper, recents, and
	// dismiss controls above are all interactive the instant the popover opens —
	// they never wait on the wheel's dynamic import. If iro fails to load, the
	// popover degrades to a hex-only picker instead of breaking.
	try {
		const iro = await loadIro();
		if (closed || !el.isConnected) return { close };
		cp = new iro.ColorPicker(wheelHost, {
			width: 200,
			color: lastHex,
			borderWidth: 1,
			borderColor: 'rgba(255,255,255,0.12)',
			layout: [
				{ component: iro.ui.Wheel },
				{ component: iro.ui.Slider, options: { sliderType: 'value' } },
			],
		});
		cp.on('color:change', (color) => {
			if (suppressInput) return;
			const hex = color.hexString.toLowerCase();
			lastHex = hex;
			hexInput.value = hex.toUpperCase();
			hexInput.classList.remove('bad');
			onInput?.(hex);
		});
		cp.on('input:end', (color) => commit(color.hexString));
		// Re-fit position now that the wheel has given the popover its full height.
		positionPopover(el, anchorEl);
	} catch (err) {
		log.warn('[avatar-studio] iro picker failed to load; hex-only fallback', err);
		const note = document.createElement('div');
		note.className = 'as-cp-empty';
		note.textContent = 'Wheel unavailable — type a hex value below.';
		wheelHost.replaceWith(note);
	}

	return { close };
}

export function closeActivePopover() {
	if (activePopover) activePopover.close();
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}
