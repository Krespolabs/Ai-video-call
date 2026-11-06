/**
 * Modal — canonical accessible modal primitive for three.ws.
 *
 * Built on native <dialog>/showModal() which gives us for free:
 *   - Spec-compliant focus trap (focus cycles inside the dialog)
 *   - ESC key to close via the native 'cancel' event
 *   - ::backdrop pseudo-element scrim
 *   - Top-layer stacking (no z-index battles)
 *
 * API
 * ───
 *   const modal = new Modal({ title, body, actions, onClose, dismissible });
 *   modal.open(triggerEl?)   — opens, locks scroll, saves focus trigger
 *   modal.close()            — animates close, unlocks scroll, returns focus
 *   modal.destroy()          — closes + removes element from DOM
 *
 *   Modal.show(opts)         — one-shot: create, open, return instance
 *
 * Exposed DOM slots (update content after construction):
 *   modal.titleEl    — <h2 id="…">   (wired to aria-labelledby)
 *   modal.bodyEl     — <div id="…">  (wired to aria-describedby)
 *   modal.actionsEl  — <div .tws-modal-actions>  (hidden when empty)
 *
 * Options
 * ───────
 *   title       {string|Node}   Modal heading (text or DOM node)
 *   body        {string|Node}   Body content (HTML string or DOM node)
 *   actions     {string|Node}   Action buttons (HTML string or DOM node)
 *   onClose     {() => void}    Called after the modal finishes closing
 *   dismissible {boolean=true}  ESC + backdrop click close the modal
 */

let _lockDepth = 0;
let _bodyOverflow = '';

function _lockScroll() {
	if (_lockDepth++ === 0) {
		_bodyOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	}
}

function _unlockScroll() {
	if (--_lockDepth <= 0) {
		_lockDepth = 0;
		document.body.style.overflow = _bodyOverflow;
	}
}

let _uid = 0;

// Self-contained shell styles. The canonical `.tws-modal*` rules live in
// style.css, which most pages load. Some bespoke full-screen surfaces (e.g.
// the /club 3D scene) deliberately skip the global stylesheet and would render
// this modal naked. Inject the shell here — but ONLY when the design system is
// absent, detected via the `--modal-bg` token. On style.css pages this is a
// no-op, so there is zero risk of cascade drift. Token references carry literal
// fallbacks so the modal looks right even without tokens.css.
const FALLBACK_STYLE_ID = 'tws-modal-fallback-styles';

function ensureModalStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(FALLBACK_STYLE_ID)) return;
	try {
		const present = getComputedStyle(document.documentElement)
			.getPropertyValue('--modal-bg')
			.trim();
		if (present) return; // style.css is loaded — canonical rules already apply.
	} catch {
		/* getComputedStyle can throw in detached contexts — fall through and inject. */
	}
	const style = document.createElement('style');
	style.id = FALLBACK_STYLE_ID;
	style.textContent = `
.tws-modal {
	border: none; padding: 0; background: transparent; color: inherit;
	max-width: min(var(--modal-width, 480px), calc(100vw - 2rem));
	max-height: calc(100svh - 2rem); overflow: visible;
	opacity: 1; transform: scale(1) translateY(0);
	transition: opacity .2s ease, transform .2s ease;
}
.tws-modal::backdrop { background: var(--modal-backdrop, rgba(0, 0, 0, .7)); transition: opacity .2s ease; }
@starting-style {
	.tws-modal[open] { opacity: 0; transform: scale(.96) translateY(10px); }
	.tws-modal[open]::backdrop { opacity: 0; }
}
.tws-modal--closing { opacity: 0 !important; transform: scale(.96) translateY(10px) !important; }
.tws-modal--closing::backdrop { opacity: 0 !important; }
.tws-modal-inner {
	background: var(--modal-bg, rgba(10, 11, 18, .96));
	border: 1px solid var(--modal-border, rgba(255, 255, 255, .14));
	border-radius: var(--modal-radius, 16px);
	box-shadow: var(--modal-shadow, 0 24px 64px rgba(0, 0, 0, .6), 0 4px 16px rgba(0, 0, 0, .4));
	width: min(var(--modal-width, 480px), calc(100vw - 2rem));
	max-height: calc(100svh - 4rem); overflow: hidden;
	display: flex; flex-direction: column;
}
.tws-modal-header {
	display: flex; align-items: center; justify-content: space-between;
	gap: var(--space-sm, .75rem); padding: var(--space-md, 1rem) var(--space-lg, 1.5rem);
	border-bottom: 1px solid var(--modal-border, rgba(255, 255, 255, .14)); flex-shrink: 0;
}
.tws-modal-title {
	margin: 0; font-size: var(--text-base, 1.05rem); font-weight: 600;
	color: var(--ink, #f5f7fa); line-height: var(--leading-tight, 1.25);
}
.tws-modal-close {
	background: none; border: none; color: var(--ink-dim, rgba(245, 247, 250, .6));
	font-size: 1.1rem; line-height: 1; cursor: pointer;
	padding: var(--space-xs, .35rem) var(--space-sm, .5rem);
	border-radius: var(--radius-sm, 8px); transition: color .15s, background .15s; flex-shrink: 0;
}
.tws-modal-close:hover { color: var(--ink, #f5f7fa); background: var(--surface-2, rgba(255, 255, 255, .06)); }
.tws-modal-close:focus-visible { outline: 2px solid var(--accent, #a4f0bc); outline-offset: 2px; }
.tws-modal-body {
	padding: var(--space-lg, 1.5rem); overflow-y: auto; flex: 1;
	color: var(--ink-dim, rgba(245, 247, 250, .6));
}
.tws-modal-actions {
	display: flex; justify-content: flex-end; gap: var(--space-sm, .75rem);
	padding: var(--space-md, 1rem) var(--space-lg, 1.5rem);
	border-top: 1px solid var(--modal-border, rgba(255, 255, 255, .14));
	flex-shrink: 0; flex-wrap: wrap;
}
.tws-modal-actions[hidden] { display: none; }
`;
	(document.head || document.documentElement).appendChild(style);
}

export class Modal {
	constructor({ title = '', body = '', actions = '', onClose, dismissible = true } = {}) {
		ensureModalStyles();
		const id = ++_uid;
		this._titleId = `tws-modal-title-${id}`;
		this._bodyId  = `tws-modal-body-${id}`;
		this._trigger  = null;
		this._onClose  = onClose;
		this._dismissible = dismissible;
		this._closing  = false;

		const el = document.createElement('dialog');
		el.className = 'tws-modal';
		el.setAttribute('aria-modal', 'true');
		el.setAttribute('aria-labelledby', this._titleId);
		el.setAttribute('aria-describedby', this._bodyId);
		el.innerHTML = `
			<div class="tws-modal-inner">
				<div class="tws-modal-header">
					<h2 class="tws-modal-title" id="${this._titleId}"></h2>
					<button class="tws-modal-close" aria-label="Close dialog" type="button">&#x2715;</button>
				</div>
				<div class="tws-modal-body" id="${this._bodyId}"></div>
				<div class="tws-modal-actions"></div>
			</div>
		`;

		this.el         = el;
		this.titleEl    = el.querySelector('.tws-modal-title');
		this.bodyEl     = el.querySelector('.tws-modal-body');
		this.actionsEl  = el.querySelector('.tws-modal-actions');
		this._closeBtn  = el.querySelector('.tws-modal-close');

		_setSlot(this.titleEl, title, 'text');
		_setSlot(this.bodyEl,   body,   'html');
		_setSlot(this.actionsEl, actions, 'html');

		if (!actions) this.actionsEl.hidden = true;

		document.body.appendChild(el);

		this._onCancel = (e) => {
			e.preventDefault();
			if (this._dismissible) this._startClose();
		};

		this._onBackdropClick = (e) => {
			if (!this._dismissible) return;
			// The <dialog> fills only the inner card; clicks outside its bounding rect
			// hit the ::backdrop, registering as a click on the <dialog> itself.
			const rect = el.getBoundingClientRect();
			if (
				e.clientX < rect.left || e.clientX > rect.right ||
				e.clientY < rect.top  || e.clientY > rect.bottom
			) {
				this._startClose();
			}
		};

		el.addEventListener('cancel', this._onCancel);
		el.addEventListener('click',  this._onBackdropClick);
		this._closeBtn.addEventListener('click', () => this._startClose());
	}

	/** Opens the modal. Optionally pass the element that triggered it so focus returns on close. */
	open(triggerEl = null) {
		this._trigger = triggerEl instanceof Element ? triggerEl : document.activeElement;
		_lockScroll();
		this.el.showModal();
		// Move focus to first interactive element inside (native focus trap takes over after)
		const firstFocusable = this.el.querySelector(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
		);
		if (firstFocusable) firstFocusable.focus();
		return this;
	}

	/** Closes the modal with the exit animation, then restores state. */
	close() {
		this._startClose();
		return this;
	}

	_startClose() {
		if (!this.el.open || this._closing) return;
		this._closing = true;
		this.el.classList.add('tws-modal--closing');
		// Wait for CSS transition (200ms) before calling dialog.close()
		setTimeout(() => this._finishClose(), 210);
	}

	_finishClose() {
		if (!this.el.open) return;
		this.el.close();
		this.el.classList.remove('tws-modal--closing');
		this._closing = false;
		_unlockScroll();
		this._trigger?.focus();
		this._trigger = null;
		this._onClose?.();
	}

	/** Removes the modal element from the DOM entirely. */
	destroy() {
		if (this.el.open) {
			// Close immediately without animation so the element can be removed
			this.el.classList.remove('tws-modal--closing');
			this._closing = false;
			if (this.el.open) this.el.close();
			_unlockScroll();
			this._trigger?.focus();
		}
		this.el.removeEventListener('cancel', this._onCancel);
		this.el.removeEventListener('click',  this._onBackdropClick);
		this.el.remove();
	}

	/** One-shot: create + open immediately, return the instance. */
	static show(opts) {
		return new Modal(opts).open();
	}
}

function _setSlot(el, value, mode) {
	if (!value) return;
	if (value instanceof Node) {
		el.appendChild(value);
	} else if (mode === 'text') {
		el.textContent = String(value);
	} else {
		el.innerHTML = String(value);
	}
}
