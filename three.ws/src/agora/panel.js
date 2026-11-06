// Agora — the shared side panel (drawer) every trust-surface view mounts into:
// job detail, the living passport, the verifier, the handshake. One accessible
// shell so focus-trapping, Escape-to-close, focus restoration, ARIA wiring and
// the close affordance are correct and identical everywhere — the panels above
// only fill the body.

// Tiny hyperscript helper. `h('div', { class: 'x', onclick: fn }, [childNodes])`.
// Keeps the panel modules declarative without pulling in a framework. Strings in
// the children array become text nodes; null/false/undefined are skipped.
export function h(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props || {})) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k === 'dataset') Object.assign(node.dataset, v);
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
		else if (k === 'text') node.textContent = v;
		else node.setAttribute(k, v === true ? '' : String(v));
	}
	const kids = Array.isArray(children) ? children : [children];
	for (const c of kids) {
		if (c == null || c === false) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

export function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

// Tear down any embedded GLB orbit viewer (verify.js → glb-viewer.js) living in a
// subtree before it's removed or hidden. glb-viewer stashes its teardown on the
// container as `_agoraViewerDestroy`; each viewer owns a WebGLRenderer (its own GL
// context + rAF loop), and browsers cap live contexts — so a viewer left running
// after the panel body is replaced or the drawer closes would leak a context and,
// after enough verifications, evict the main world's renderer. Idempotent.
export function destroyViewers(node) {
	if (!node) return;
	const kill = (el) => { try { el._agoraViewerDestroy?.(); } catch { /* best-effort */ } };
	if (node._agoraViewerDestroy) kill(node);
	node.querySelectorAll?.('*').forEach((el) => { if (el._agoraViewerDestroy) kill(el); });
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// A copy-to-clipboard chip for a hash or address. Shows the truncated value and
// flips to a ✓ for 1.2s on copy. Falls back gracefully where the Clipboard API
// is blocked (insecure context) by selecting a hidden textarea + execCommand.
export function copyChip(value, label) {
	const full = String(value ?? '');
	const btn = h('button', {
		class: 'agora-copy',
		type: 'button',
		title: `Copy ${label || 'value'}`,
		'aria-label': `Copy ${label || 'value'}: ${full}`,
	}, [
		h('span', { class: 'agora-copy-text' }, [label || full]),
		h('span', { class: 'agora-copy-icon', 'aria-hidden': 'true' }, ['⧉']),
	]);
	btn.addEventListener('click', async () => {
		const ok = await copyText(full);
		const icon = btn.querySelector('.agora-copy-icon');
		btn.classList.toggle('is-ok', ok);
		btn.classList.toggle('is-fail', !ok);
		if (icon) icon.textContent = ok ? '✓' : '✕';
		setTimeout(() => {
			btn.classList.remove('is-ok', 'is-fail');
			if (icon) icon.textContent = '⧉';
		}, 1200);
	});
	return btn;
}

export async function copyText(text) {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch { /* fall through to legacy path */ }
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}

// An accessible right-side drawer. Construct once per logical panel; call open()
// to show with fresh content and close() to hide. Only one Panel should be open
// at a time — the host (agora-world) enforces that.
export class Panel {
	// onClose fires after the panel hides (host clears deep-link state there).
	constructor({ id, onClose } = {}) {
		this._onClose = onClose;
		this._opener = null;
		this._open = false;

		this.titleEl = h('h2', { class: 'agora-panel-title', id: `${id}-title` });
		this.subEl = h('div', { class: 'agora-panel-sub' });
		this.bodyEl = h('div', { class: 'agora-panel-body' });

		this.closeBtn = h('button', {
			class: 'agora-panel-close',
			type: 'button',
			'aria-label': 'Close panel',
			title: 'Close (Esc)',
		}, ['✕']);
		this.closeBtn.addEventListener('click', () => this.close());

		this.root = h('aside', {
			id,
			class: 'agora-panel',
			role: 'dialog',
			'aria-modal': 'false',
			'aria-labelledby': `${id}-title`,
			tabindex: '-1',
			hidden: true,
		}, [
			h('header', { class: 'agora-panel-head' }, [
				h('div', { class: 'agora-panel-head-text' }, [this.titleEl, this.subEl]),
				this.closeBtn,
			]),
			this.bodyEl,
		]);

		this._onKeydown = (e) => {
			if (!this._open) return;
			if (e.key === 'Escape') { e.stopPropagation(); this.close(); return; }
			if (e.key === 'Tab') this._trapTab(e);
		};
		this.root.addEventListener('keydown', this._onKeydown);
	}

	mount(parent) {
		parent.appendChild(this.root);
		return this;
	}

	setHeader(title, sub) {
		this.titleEl.textContent = title || '';
		if (sub == null) { this.subEl.textContent = ''; this.subEl.hidden = true; }
		else { this.subEl.hidden = false; clear(this.subEl); this.subEl.appendChild(typeof sub === 'string' ? document.createTextNode(sub) : sub); }
		return this;
	}

	// Replace the body with a node (or array of nodes).
	setBody(content) {
		destroyViewers(this.bodyEl); // free any GLB viewer before dropping its DOM
		clear(this.bodyEl);
		const kids = Array.isArray(content) ? content : [content];
		for (const c of kids) if (c) this.bodyEl.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		this.bodyEl.scrollTop = 0;
		return this;
	}

	// Designed loading state: skeleton rows (no spinner).
	setLoading(label = 'Loading…') {
		this.setBody(h('div', { class: 'agora-state agora-state-loading', role: 'status', 'aria-live': 'polite' }, [
			h('span', { class: 'agora-skel agora-skel-line' }),
			h('span', { class: 'agora-skel agora-skel-line short' }),
			h('span', { class: 'agora-skel agora-skel-block' }),
			h('span', { class: 'agora-skel agora-skel-line' }),
			h('span', { class: 'sr-only' }, [label]),
		]));
		return this;
	}

	// Designed, actionable error state. retry, if given, renders a Retry button.
	setError(message, retry) {
		this.setBody(h('div', { class: 'agora-state agora-state-error', role: 'alert' }, [
			h('div', { class: 'agora-state-icon', 'aria-hidden': 'true' }, ['⚠']),
			h('p', { class: 'agora-state-msg' }, [message || 'Something went wrong.']),
			retry ? h('button', { class: 'agora-btn', type: 'button', onclick: retry }, ['Try again']) : null,
		]));
		return this;
	}

	// Designed empty state.
	setEmpty(message, hint) {
		this.setBody(h('div', { class: 'agora-state agora-state-empty' }, [
			h('div', { class: 'agora-state-icon', 'aria-hidden': 'true' }, ['◌']),
			h('p', { class: 'agora-state-msg' }, [message || 'Nothing here yet.']),
			hint ? h('p', { class: 'agora-state-hint' }, [hint]) : null,
		]));
		return this;
	}

	open(opener) {
		this._opener = opener || document.activeElement;
		this.root.hidden = false;
		this._open = true;
		this.root.classList.add('is-open');
		// Move focus into the panel for keyboard + screen-reader users.
		requestAnimationFrame(() => {
			const first = this.root.querySelector(FOCUSABLE);
			(first || this.root).focus();
		});
		return this;
	}

	close() {
		if (!this._open) return;
		this._open = false;
		// Free any embedded GLB viewer so a closed drawer never leaves a WebGL
		// context + rAF loop running in the background (reopening re-renders fresh).
		destroyViewers(this.bodyEl);
		this.root.classList.remove('is-open');
		// Wait for the exit transition before hiding from the a11y tree.
		const hide = () => { if (!this._open) this.root.hidden = true; };
		this.root.addEventListener('transitionend', hide, { once: true });
		setTimeout(hide, 320);
		// Restore focus to whatever opened the panel.
		if (this._opener && typeof this._opener.focus === 'function') {
			try { this._opener.focus(); } catch { /* opener gone */ }
		}
		this._opener = null;
		if (typeof this._onClose === 'function') this._onClose();
	}

	get isOpen() { return this._open; }

	_trapTab(e) {
		// A `position: fixed` panel can report offsetParent === null for visible
		// children in some engines, which would empty this list and bounce focus to
		// the container. getClientRects() is fixed-safe: it's non-empty for anything
		// actually laid out + visible.
		const items = [...this.root.querySelectorAll(FOCUSABLE)].filter((n) => n === document.activeElement || n.getClientRects().length > 0);
		if (!items.length) { e.preventDefault(); this.root.focus(); return; }
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}
}

// A labelled key/value row used across the panels.
export function infoRow(label, value, opts = {}) {
	const valNode = typeof value === 'string' || typeof value === 'number'
		? h('span', { class: 'agora-kv-val' }, [String(value)])
		: (value || h('span', { class: 'agora-kv-val agora-muted' }, ['—']));
	return h('div', { class: `agora-kv${opts.wide ? ' wide' : ''}` }, [
		h('span', { class: 'agora-kv-key' }, [label]),
		valNode,
	]);
}

// A reward chip — always $THREE, the only coin Agora denominates in.
export function rewardChip(amountDisplay, mintLabel = '$THREE') {
	return h('span', { class: 'agora-reward' }, [
		h('span', { class: 'agora-reward-amt' }, [amountDisplay]),
		h('span', { class: 'agora-reward-coin' }, [mintLabel]),
	]);
}
