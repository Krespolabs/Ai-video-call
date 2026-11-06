/**
 * Shared loading / empty / error state components.
 *
 * Exposes token-driven skeleton-loading, empty-state, and error-state shells
 * that every grid or list surface can drop in without hand-rolling its own.
 * The visual shell is owned here; copy (especially crypto-failure messages)
 * is supplied by callers via the title/body props so C07 can swap strings
 * without touching markup or CSS.
 *
 * Pattern mirrors src/shared/onchain-badge.js:
 *   import { skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles, attachRetry } from './state-kit.js';
 *
 * CSS is injected once via ensureStateKitStyles(); call it before rendering
 * any HTML string from this module.
 */

const STYLE_ID = 'tws-state-kit-styles';

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// ── CSS injection ──────────────────────────────────────────────────────────

/** Inject the state-kit stylesheet once. Idempotent and SSR-safe. */
export function ensureStateKitStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = STATE_KIT_CSS;
	(document.head || document.documentElement).appendChild(style);
}

// ── Skeleton ───────────────────────────────────────────────────────────────

/**
 * Skeleton placeholder HTML for a card grid.
 *
 * @param {number} count  Number of skeleton cards to render.
 * @param {'card'|'row'|'text'} variant
 *   card — square-thumb card (default, matches market/forge grids)
 *   row  — horizontal list row (dashboard lists)
 *   text — text-only block (activity feeds)
 * @returns {string} HTML string; wrap in a grid container before inserting.
 */
export function skeletonHTML(count = 6, variant = 'card') {
	ensureStateKitStyles();
	const items = Array.from({ length: count }, () => {
		if (variant === 'row') {
			return `<div class="tws-sk tws-sk--row" aria-hidden="true">
				<div class="tws-sk-avatar"></div>
				<div class="tws-sk-body">
					<div class="tws-sk-line"></div>
					<div class="tws-sk-line tws-sk-line--short"></div>
				</div>
			</div>`;
		}
		if (variant === 'text') {
			return `<div class="tws-sk tws-sk--text" aria-hidden="true">
				<div class="tws-sk-line"></div>
				<div class="tws-sk-line tws-sk-line--medium"></div>
				<div class="tws-sk-line tws-sk-line--short"></div>
			</div>`;
		}
		// card (default)
		return `<div class="tws-sk tws-sk--card" aria-hidden="true">
			<div class="tws-sk-thumb"></div>
			<div class="tws-sk-line"></div>
			<div class="tws-sk-line tws-sk-line--short"></div>
		</div>`;
	});
	return items.join('');
}

/**
 * Skeleton as a DocumentFragment for DOM-build render sites.
 */
export function skeletonEl(count = 6, variant = 'card') {
	const html = skeletonHTML(count, variant);
	const tpl = document.createElement('template');
	tpl.innerHTML = html;
	return tpl.content;
}

// ── Empty state ────────────────────────────────────────────────────────────

/**
 * Empty-state HTML block.
 *
 * @param {object} opts
 * @param {string} [opts.icon]     Emoji or raw SVG string. Omit for the default dot grid;
 *                                 pass an empty string ('') to render no icon at all.
 * @param {string} opts.title      Headline — required.
 * @param {string} opts.body       Helper copy — required. Pre-escaped HTML ok.
 * @param {Array<{label:string, id?:string, href?:string, primary?:boolean}>} [opts.actions]
 *   Mark one action `primary: true` for the main CTA; others render as secondary buttons.
 * @param {boolean} [opts.live]    Use aria-live="polite" (for in-place updates); default false → role="status".
 * @param {boolean} [opts.compact] Tighter padding + smaller icon for inline panels, table
 *                                 cells, tickers and side-rail feeds (vs. full-page grids).
 * @param {string} [opts.tip]      Optional technical detail tucked behind an info tooltip
 *                                 (keeps the headline copy plain — see three-live).
 * @returns {string} HTML string.
 */
export function emptyStateHTML({ icon, title, body, actions = [], live = false, compact = false, tip } = {}) {
	ensureStateKitStyles();

	const defaultDot = `<div class="tws-es-icon tws-es-icon--dot" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="2.5" fill="currentColor" opacity=".25"/><circle cx="20" cy="8" r="2.5" fill="currentColor" opacity=".35"/><circle cx="32" cy="8" r="2.5" fill="currentColor" opacity=".25"/><circle cx="8" cy="20" r="2.5" fill="currentColor" opacity=".35"/><circle cx="20" cy="20" r="3" fill="currentColor" opacity=".6"/><circle cx="32" cy="20" r="2.5" fill="currentColor" opacity=".35"/><circle cx="8" cy="32" r="2.5" fill="currentColor" opacity=".25"/><circle cx="20" cy="32" r="2.5" fill="currentColor" opacity=".35"/><circle cx="32" cy="32" r="2.5" fill="currentColor" opacity=".25"/></svg></div>`;
	const iconHtml = icon === undefined
		? defaultDot
		: icon
			? `<div class="tws-es-icon">${icon}</div>`
			: '';

	const ariaAttr = live ? 'aria-live="polite"' : 'role="status"';

	const btns = actions.map((a) => {
		if (a.href) {
			return `<a class="tws-es-btn${a.primary ? ' tws-es-btn--primary' : ''}" href="${esc(a.href)}"${a.id ? ` data-sk-action="${esc(a.id)}"` : ''}>${esc(a.label)}</a>`;
		}
		return `<button type="button" class="tws-es-btn${a.primary ? ' tws-es-btn--primary' : ''}"${a.id ? ` data-sk-action="${esc(a.id)}"` : ''}>${esc(a.label)}</button>`;
	}).join('');

	const tipHtml = tip
		? `<span class="tws-es-tip" tabindex="0" role="note" aria-label="${esc(tip)}" data-tws-tip="${esc(tip)}"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.3" opacity=".5"/><path d="M8 7v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.5" r=".9" fill="currentColor"/></svg></span>`
		: '';

	return `<div class="tws-es${compact ? ' tws-es--compact' : ''}" ${ariaAttr}>
		${iconHtml}
		<h3 class="tws-es-title">${esc(title)}</h3>
		<p class="tws-es-body">${body}${tipHtml}</p>
		${btns ? `<div class="tws-es-actions">${btns}</div>` : ''}
	</div>`;
}

/** Empty state as a DOM Element. */
export function emptyStateEl(opts = {}) {
	const tpl = document.createElement('template');
	tpl.innerHTML = emptyStateHTML(opts).trim();
	return tpl.content.firstElementChild;
}

// ── Error state ────────────────────────────────────────────────────────────

/**
 * Error-state HTML block.
 *
 * Visual shell only — the caller supplies copy. C07 owns crypto-failure messages.
 *
 * @param {object} opts
 * @param {string} [opts.title]    Defaults to "Something went wrong".
 * @param {string} [opts.body]     Error description. Pre-escaped HTML ok.
 * @param {string} [opts.scope]    Data attribute on retry button for delegation ('agents'|'skills'|...).
 * @param {Array<{label:string, id?:string, primary?:boolean}>} [opts.actions]
 *   When omitted, a single "Retry" primary button is rendered automatically.
 * @returns {string} HTML string.
 */
export function errorStateHTML({ title, body, scope = '', actions } = {}) {
	ensureStateKitStyles();

	const heading = title || 'Something went wrong';
	const desc = body || 'Check your connection and try again.';

	let btns;
	if (actions && actions.length) {
		btns = actions.map((a) =>
			`<button type="button" class="tws-es-btn${a.primary ? ' tws-es-btn--primary' : ''}"${a.id ? ` data-sk-action="${esc(a.id)}"` : ''}${scope ? ` data-sk-scope="${esc(scope)}"` : ''}>${esc(a.label)}</button>`
		).join('');
	} else {
		btns = `<button type="button" class="tws-es-btn tws-es-btn--primary" data-sk-retry${scope ? ` data-sk-scope="${esc(scope)}"` : ''}>Retry</button>`;
	}

	return `<div class="tws-es tws-es--error" role="alert">
		<div class="tws-es-icon tws-es-icon--err" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="1.5" opacity=".35"/><path d="M16 9v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="22.5" r="1.25" fill="currentColor"/></svg></div>
		<h3 class="tws-es-title">${esc(heading)}</h3>
		<p class="tws-es-body">${desc}</p>
		<div class="tws-es-actions">${btns}</div>
	</div>`;
}

/** Error state as a DOM Element. */
export function errorStateEl(opts = {}) {
	const tpl = document.createElement('template');
	tpl.innerHTML = errorStateHTML(opts).trim();
	return tpl.content.firstElementChild;
}

// ── Retry wiring ───────────────────────────────────────────────────────────

/**
 * Attach a retry handler to all [data-sk-retry] buttons within a container.
 * Uses event delegation so it survives innerHTML re-renders.
 *
 * @param {Element} container  The element whose innerHTML may contain retry buttons.
 * @param {function} retryFn   Called with no arguments when a retry button is clicked.
 */
export function attachRetry(container, retryFn) {
	if (!container || typeof retryFn !== 'function') return;
	container.addEventListener('click', (e) => {
		if (e.target.closest('[data-sk-retry]')) retryFn();
	});
}

// ── CSS ────────────────────────────────────────────────────────────────────

const STATE_KIT_CSS = `
/* ═══════════════════════════════════════════════════════════════════════════
   three.ws state-kit — skeleton / empty / error shared components
   Source: src/shared/state-kit.js · Namespace: tws-sk-* / tws-es-*
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Skeleton shimmer keyframe (GPU-composited transform) ── */
@keyframes tws-sk-sweep {
  0%   { transform: translateX(-150%); }
  100% { transform: translateX(150%);  }
}

/* ── Skeleton base ── */
.tws-sk {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-card, 14px);
  background: var(--surface-2, rgba(255,255,255,0.05));
  border: 1px solid var(--stroke, rgba(255,255,255,0.07));
}

/* Shimmer overlay on all skeleton children with the class */
.tws-sk-thumb,
.tws-sk-line,
.tws-sk-avatar {
  position: relative;
  overflow: hidden;
  background: var(--surface-3, rgba(255,255,255,0.08));
  border-radius: var(--radius-sm, 4px);
}
.tws-sk-thumb::after,
.tws-sk-line::after,
.tws-sk-avatar::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-150%);
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.06) 50%,
    transparent 100%
  );
  animation: tws-sk-sweep 1.6s ease-in-out infinite;
}

/* Card variant — vertical, square thumb */
.tws-sk--card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  min-height: 240px;
}
.tws-sk--card .tws-sk-thumb {
  flex: 1;
  border-radius: var(--radius-md, 8px);
  min-height: 140px;
}
.tws-sk--card .tws-sk-line {
  height: 12px;
  width: 100%;
}
.tws-sk--card .tws-sk-line.tws-sk-line--short { width: 55%; }
.tws-sk--card .tws-sk-line.tws-sk-line--medium { width: 75%; }

/* Row variant — horizontal, avatar + lines */
.tws-sk--row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: var(--radius-md, 8px);
}
.tws-sk--row .tws-sk-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tws-sk--row .tws-sk-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tws-sk--row .tws-sk-line {
  height: 11px;
  width: 100%;
}
.tws-sk--row .tws-sk-line.tws-sk-line--short { width: 45%; }

/* Text variant — lines only */
.tws-sk--text {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 16px;
  border-radius: var(--radius-md, 8px);
}
.tws-sk--text .tws-sk-line {
  height: 11px;
  width: 100%;
}
.tws-sk--text .tws-sk-line.tws-sk-line--medium { width: 72%; }
.tws-sk--text .tws-sk-line.tws-sk-line--short  { width: 40%; }

/* ── Empty + error state shell ── */
.tws-es {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  padding: 56px 24px 48px;
  /* span full grid width when inside a CSS grid */
  grid-column: 1 / -1;
}

.tws-es-icon {
  font-size: 36px;
  line-height: 1;
  margin-bottom: 4px;
  color: var(--ink-dim, #888);
  opacity: 0.7;
}
.tws-es-icon--dot {
  color: var(--ink-dim, #888);
}
.tws-es-icon--err {
  color: var(--danger, #f87171);
  opacity: 0.85;
}

.tws-es-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink, #e8e8e8);
  letter-spacing: -.01em;
}

.tws-es-body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink-dim, #888);
  max-width: 340px;
}

.tws-es-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 8px;
}

/* Compact modifier — tighter footprint for inline panels, table cells,
   tickers and side-rail feeds (vs. full-page grids). */
.tws-es--compact {
  padding: 22px 16px 20px;
  gap: 7px;
}
.tws-es--compact .tws-es-icon {
  font-size: 26px;
  margin-bottom: 2px;
}
.tws-es--compact .tws-es-icon--dot svg { width: 30px; height: 30px; }
.tws-es--compact .tws-es-title { font-size: 14px; }
.tws-es--compact .tws-es-body { font-size: 12.5px; line-height: 1.5; }
.tws-es--compact .tws-es-actions { margin-top: 4px; }

/* Error modifier — title color shifts to danger */
.tws-es--error .tws-es-title {
  color: var(--danger, #f87171);
}

/* ── Info tooltip (tucks technical detail behind a hover/focus affordance) ── */
.tws-es-tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  margin-left: 6px;
  width: 16px;
  height: 16px;
  color: var(--ink-dim, #888);
  cursor: help;
  border-radius: 50%;
  position: relative;
  transition: color 0.15s ease;
}
.tws-es-tip:hover,
.tws-es-tip:focus-visible { color: var(--ink, #e8e8e8); }
.tws-es-tip:focus-visible {
  outline: 2px solid rgba(255,255,255,0.4);
  outline-offset: 2px;
}
.tws-es-tip::after {
  content: attr(data-tws-tip);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  width: max-content;
  max-width: 240px;
  padding: 7px 10px;
  border-radius: var(--radius-sm, 6px);
  background: var(--modal-bg, rgba(10,11,18,0.96));
  border: 1px solid var(--stroke-strong, rgba(255,255,255,0.14));
  box-shadow: var(--shadow-2, 0 4px 24px rgba(0,0,0,0.4));
  color: var(--ink, #e8e8e8);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.4;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 10;
}
.tws-es-tip:hover::after,
.tws-es-tip:focus-visible::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* ── State-kit buttons (CTA + retry) ── */
.tws-es-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--btn-pad-y, 0.618rem) var(--btn-pad-x, 1rem);
  border-radius: var(--btn-radius, var(--radius-control, 10px));
  font: 600 var(--btn-text-size, 13px)/1 var(--font-body, system-ui, sans-serif);
  cursor: pointer;
  border: 1px solid var(--btn-secondary-border, rgba(255,255,255,0.1));
  background: var(--btn-secondary-bg, rgba(255,255,255,0.08));
  color: var(--btn-secondary-fg, var(--ink, #e8e8e8));
  text-decoration: none;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
}
.tws-es-btn:hover {
  background: var(--btn-secondary-bg-hover, rgba(255,255,255,0.12));
  border-color: var(--stroke-strong, rgba(255,255,255,0.18));
}
.tws-es-btn:active { transform: translateY(1px); }
.tws-es-btn:focus-visible {
  outline: 2px solid rgba(255,255,255,0.4);
  outline-offset: 2px;
}
.tws-es-btn--primary {
  background: var(--btn-primary-bg, rgba(255,255,255,0.9));
  color: var(--btn-primary-fg, #0a0a0f);
  border-color: transparent;
}
.tws-es-btn--primary:hover {
  background: var(--btn-primary-bg-hover, rgba(255,255,255,0.88));
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  .tws-sk-thumb::after,
  .tws-sk-line::after,
  .tws-sk-avatar::after {
    animation: none;
  }
}
`;

if (typeof window !== 'undefined') {
	window.twsStateKit = { skeletonHTML, skeletonEl, emptyStateHTML, emptyStateEl, errorStateHTML, errorStateEl, ensureStateKitStyles, attachRetry };
}
