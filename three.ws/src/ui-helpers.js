/**
 * Shared UI helpers — toast notifications.
 *
 * A single, self-contained toast system any page can import without shipping
 * markup or CSS: the fixed container and its styles are injected into the DOM on
 * first use, styled entirely from the design tokens in public/tokens.css so it
 * tracks the active theme (dark/light) automatically.
 *
 * Why a helper instead of per-page toasts: feedback for saves, payments, and
 * errors was previously ad-hoc — status text next to buttons, page-local toast
 * functions with divergent look and a11y. This is the one toast surface.
 *
 * API
 * ───
 *   import { showToast } from './ui-helpers.js';
 *
 *   showToast(message, options?) -> dismiss()
 *
 *   message  string  — text shown to the user (rendered as text, never HTML).
 *   options  object  — all optional:
 *     type      'info' | 'success' | 'error' | 'warning'  (default 'info')
 *     duration  number ms before auto-dismiss; 0 / Infinity = sticky
 *                (default 4000; errors default 6000 so they're readable).
 *     action    { label: string, onClick: (dismiss) => void }
 *                renders an inline action button (e.g. "Undo", "Retry").
 *
 *   Returns a dismiss() function so callers can close a sticky toast manually.
 *
 * Behaviour
 * ─────────
 *   · Stacked, newest on top, capped at MAX_TOASTS (oldest evicted first).
 *   · Auto-dismiss with pause-on-hover and pause-on-focus-within, so a toast
 *     under the pointer or holding keyboard focus won't vanish mid-read.
 *   · Manual dismiss via the × button or the action callback.
 *   · Accessible: container is aria-live; errors announce assertively
 *     (role="alert"), others politely (role="status"). Action + close buttons
 *     are real <button>s with aria-labels and visible focus rings.
 *   · prefers-reduced-motion: enter/exit animations collapse to instant.
 *
 * No central registration is required — it's an ES module; import where used.
 */

const CONTAINER_ID = 'three-toast-container';
const STYLE_ID = 'three-toast-styles';
const MAX_TOASTS = 4;

const DEFAULT_DURATIONS = { info: 4000, success: 4000, warning: 5000, error: 6000 };

const prefersReducedMotion = () =>
	typeof window !== 'undefined' &&
	typeof window.matchMedia === 'function' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ICONS = {
	success: '✓',
	error: '✕',
	warning: '!',
	info: 'i',
};

function injectStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
#${CONTAINER_ID} {
	position: fixed;
	bottom: var(--space-md, 16px);
	right: var(--space-md, 16px);
	z-index: 2147483000;
	display: flex;
	flex-direction: column-reverse;
	gap: var(--space-sm, 10px);
	max-width: min(360px, calc(100vw - 2 * var(--space-md, 16px)));
	pointer-events: none;
}
#${CONTAINER_ID} .three-toast {
	pointer-events: auto;
	display: flex;
	align-items: flex-start;
	gap: var(--space-sm, 10px);
	padding: var(--space-sm, 10px) var(--space-md, 16px);
	border-radius: var(--radius-md, 10px);
	border: 1px solid var(--color-border, rgba(255,255,255,0.08));
	border-left-width: 3px;
	background: var(--bg-1, #1a1a1a);
	color: var(--color-text, #e8e8e8);
	font-family: var(--font-body, system-ui, sans-serif);
	font-size: 14px;
	line-height: 1.4;
	box-shadow: var(--shadow-2, 0 4px 24px rgba(0,0,0,0.4));
	transition: opacity var(--duration-base, 220ms) var(--ease-out, ease),
		transform var(--duration-base, 220ms) var(--ease-emphasized, ease);
	opacity: 0;
	transform: translateX(12px);
}
#${CONTAINER_ID} .three-toast.is-visible {
	opacity: 1;
	transform: translateX(0);
}
#${CONTAINER_ID} .three-toast.is-leaving {
	opacity: 0;
	transform: translateX(12px);
}
#${CONTAINER_ID} .three-toast-icon {
	flex: 0 0 auto;
	width: 18px;
	height: 18px;
	margin-top: 1px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 700;
	line-height: 1;
	color: var(--bg-0, #0a0a0a);
}
#${CONTAINER_ID} .three-toast-body {
	flex: 1 1 auto;
	min-width: 0;
	word-break: break-word;
}
#${CONTAINER_ID} .three-toast-action {
	margin-top: var(--space-2xs, 4px);
	display: inline-block;
	background: transparent;
	border: 1px solid var(--color-border-strong, rgba(255,255,255,0.14));
	border-radius: var(--radius-sm, 6px);
	color: var(--color-text-bright, #fff);
	font: inherit;
	font-size: 13px;
	font-weight: 600;
	padding: 3px 10px;
	cursor: pointer;
	transition: background var(--duration-fast, 140ms) ease, border-color var(--duration-fast, 140ms) ease;
}
#${CONTAINER_ID} .three-toast-action:hover {
	background: var(--surface-2, rgba(255,255,255,0.05));
	border-color: var(--color-text-dim, #888);
}
#${CONTAINER_ID} .three-toast-close {
	flex: 0 0 auto;
	background: transparent;
	border: none;
	color: var(--color-text-dim, #888);
	font-size: 18px;
	line-height: 1;
	padding: 0 0 0 var(--space-2xs, 4px);
	margin: -2px -4px -2px 0;
	cursor: pointer;
	border-radius: var(--radius-sm, 6px);
	transition: color var(--duration-fast, 140ms) ease;
}
#${CONTAINER_ID} .three-toast-close:hover {
	color: var(--color-text-bright, #fff);
}
#${CONTAINER_ID} .three-toast-action:focus-visible,
#${CONTAINER_ID} .three-toast-close:focus-visible {
	outline: 2px solid var(--focus-ring-color, var(--accent, #fff));
	outline-offset: 2px;
}
#${CONTAINER_ID} .three-toast.toast-success { border-left-color: var(--color-success, #4ade80); }
#${CONTAINER_ID} .three-toast.toast-error   { border-left-color: var(--color-danger, #f87171); }
#${CONTAINER_ID} .three-toast.toast-warning { border-left-color: var(--color-warning, #fbbf24); }
#${CONTAINER_ID} .three-toast.toast-info    { border-left-color: var(--color-accent, #fff); }
#${CONTAINER_ID} .three-toast.toast-success .three-toast-icon { background: var(--color-success, #4ade80); }
#${CONTAINER_ID} .three-toast.toast-error   .three-toast-icon { background: var(--color-danger, #f87171); }
#${CONTAINER_ID} .three-toast.toast-warning .three-toast-icon { background: var(--color-warning, #fbbf24); }
#${CONTAINER_ID} .three-toast.toast-info    .three-toast-icon { background: var(--color-accent, #fff); }
@media (prefers-reduced-motion: reduce) {
	#${CONTAINER_ID} .three-toast {
		transition: opacity 1ms linear;
		transform: none;
	}
	#${CONTAINER_ID} .three-toast.is-leaving { transform: none; }
}
`;
	document.head.appendChild(style);
}

function ensureContainer() {
	let container = document.getElementById(CONTAINER_ID);
	if (!container) {
		injectStyles();
		container = document.createElement('div');
		container.id = CONTAINER_ID;
		// Polite by default; per-toast role overrides to assertive for errors.
		container.setAttribute('aria-live', 'polite');
		container.setAttribute('aria-atomic', 'false');
		document.body.appendChild(container);
	}
	return container;
}

function evictOldest(container) {
	while (container.children.length >= MAX_TOASTS) {
		const oldest = container.firstElementChild;
		if (!oldest) break;
		oldest.dataset.evicting = '1';
		oldest.remove();
	}
}

/**
 * Display a toast notification.
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'error'|'warning', duration?: number,
 *   action?: { label: string, onClick: (dismiss: () => void) => void } }} [options]
 * @returns {() => void} dismiss — closes the toast immediately.
 */
export function showToast(message, options = {}) {
	if (typeof document === 'undefined' || !document.body) return () => {};

	const type = ['info', 'success', 'error', 'warning'].includes(options.type) ? options.type : 'info';
	const isError = type === 'error';
	const duration =
		options.duration === undefined ? DEFAULT_DURATIONS[type] : Number(options.duration);
	const sticky = !Number.isFinite(duration) || duration <= 0;

	const container = ensureContainer();
	evictOldest(container);

	const toast = document.createElement('div');
	toast.className = `three-toast toast-${type}`;
	// Errors interrupt; everything else is announced politely.
	toast.setAttribute('role', isError ? 'alert' : 'status');
	toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');

	const icon = document.createElement('span');
	icon.className = 'three-toast-icon';
	icon.setAttribute('aria-hidden', 'true');
	icon.textContent = ICONS[type];

	const body = document.createElement('div');
	body.className = 'three-toast-body';
	const text = document.createElement('span');
	text.className = 'three-toast-text';
	text.textContent = String(message ?? '');
	body.appendChild(text);

	let timer = null;
	let removed = false;

	const remove = () => {
		if (removed) return;
		removed = true;
		clearTimeout(timer);
		toast.classList.add('is-leaving');
		toast.classList.remove('is-visible');
		const done = () => toast.remove();
		if (prefersReducedMotion()) {
			done();
		} else {
			let settled = false;
			const onEnd = () => {
				if (settled) return;
				settled = true;
				done();
			};
			toast.addEventListener('transitionend', onEnd, { once: true });
			// Failsafe in case the transition never fires (tab hidden, etc.).
			setTimeout(onEnd, 400);
		}
	};

	const startTimer = () => {
		if (sticky) return;
		clearTimeout(timer);
		timer = setTimeout(remove, duration);
	};
	const pauseTimer = () => clearTimeout(timer);

	if (options.action && options.action.label) {
		const actionBtn = document.createElement('button');
		actionBtn.type = 'button';
		actionBtn.className = 'three-toast-action';
		actionBtn.textContent = options.action.label;
		actionBtn.addEventListener('click', () => {
			try {
				options.action.onClick?.(remove);
			} finally {
				remove();
			}
		});
		body.appendChild(actionBtn);
	}

	const closeBtn = document.createElement('button');
	closeBtn.type = 'button';
	closeBtn.className = 'three-toast-close';
	closeBtn.setAttribute('aria-label', 'Dismiss notification');
	closeBtn.textContent = '×';
	closeBtn.addEventListener('click', remove);

	toast.appendChild(icon);
	toast.appendChild(body);
	toast.appendChild(closeBtn);

	// Pause auto-dismiss while hovered or holding keyboard focus, so the user can
	// finish reading / interact with the action before it disappears.
	toast.addEventListener('mouseenter', pauseTimer);
	toast.addEventListener('mouseleave', startTimer);
	toast.addEventListener('focusin', pauseTimer);
	toast.addEventListener('focusout', startTimer);

	container.appendChild(toast);

	// Force a reflow so the enter transition runs from the initial state.
	void toast.offsetWidth;
	toast.classList.add('is-visible');

	startTimer();

	return remove;
}
