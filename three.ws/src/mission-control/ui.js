/**
 * Mission Control — shared UI primitives: a single styled toast and a focus-
 * trapped confirm dialog. Both are dependency-free and respect reduced motion
 * (the stylesheet gates the transitions).
 */

import { escapeHtml } from './format.js';

let toastEl = null;
let toastTimer = null;

/**
 * Transient toast. `tone` drives the left-border colour.
 * @param {string} message — may contain a single trailing link via `link`.
 * @param {{ tone?: 'ok'|'err'|'warn'|'info', ms?: number, link?: {href:string,label:string} }} [opts]
 */
export function toast(message, { tone = 'info', ms = 3200, link = null } = {}) {
	if (typeof document === 'undefined') return;
	if (!toastEl) {
		toastEl = document.createElement('div');
		toastEl.className = 'mc-toast';
		toastEl.setAttribute('role', 'status');
		toastEl.setAttribute('aria-live', 'polite');
		document.body.appendChild(toastEl);
	}
	toastEl.className = `mc-toast ${tone}`;
	toastEl.innerHTML = `${escapeHtml(message)}${
		link ? ` <a href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a>` : ''
	}`;
	// reflow so re-fired toasts re-animate
	void toastEl.offsetWidth;
	toastEl.dataset.show = 'true';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		if (toastEl) toastEl.dataset.show = 'false';
	}, ms);
}

/**
 * Modal confirm. Resolves true on confirm, false on cancel/escape/backdrop.
 * @param {{ title:string, body:string, confirmLabel?:string, tone?:'buy'|'sell'|'default' }} opts
 */
export function confirmModal({ title, body, confirmLabel = 'Confirm', tone = 'default' }) {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'mc-overlay';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', title);
		const btnClass = tone === 'buy' ? 'mc-btn mc-btn--buy' : tone === 'sell' ? 'mc-btn mc-btn--sell' : 'mc-btn mc-btn--buy';
		overlay.innerHTML = `
			<div class="mc-overlay-card" style="max-width:420px">
				<h2>${escapeHtml(title)}</h2>
				<p style="color:var(--ink-dim,#888);line-height:1.55;margin:0 0 18px">${body}</p>
				<div class="mc-trade-actions">
					<button class="mc-btn" data-act="cancel" style="background:var(--surface-2,rgba(255,255,255,.06));color:var(--ink,#e8e8e8)">Cancel</button>
					<button class="${btnClass}" data-act="ok">${escapeHtml(confirmLabel)}</button>
				</div>
			</div>`;
		document.body.appendChild(overlay);
		const okBtn = overlay.querySelector('[data-act="ok"]');
		const cancelBtn = overlay.querySelector('[data-act="cancel"]');
		let done = false;
		const close = (val) => {
			if (done) return;
			done = true;
			overlay.remove();
			document.removeEventListener('keydown', onKey, true);
			resolve(val);
		};
		const onKey = (e) => {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
			else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
			else if (e.key === 'Tab') {
				// trap focus between the two buttons
				e.preventDefault();
				(document.activeElement === okBtn ? cancelBtn : okBtn).focus();
			}
		};
		document.addEventListener('keydown', onKey, true);
		okBtn.addEventListener('click', () => close(true));
		cancelBtn.addEventListener('click', () => close(false));
		overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
		okBtn.focus();
	});
}
