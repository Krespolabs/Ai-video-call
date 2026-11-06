/**
 * AvatarPicker — @three-ws/page-agent
 * ===================================
 *
 * Accessible modal grid that lets the *visitor* choose which rigged agent talks
 * to them. Every card is one rigged avatar from the catalog; selecting one
 * swaps the live agent and persists the choice (localStorage) so it sticks
 * across pages and visits. Keyboard navigable, focus-trapped, Esc to close.
 */

const STORE_KEY = 'three-ws:page-agent:agent';

const STYLE_EMOJI = { realistic: '🧑', stylized: '✨', robot: '🤖' };

export class AvatarPicker {
	/**
	 * @param {import('./catalog.js').RiggedAgent[]} agents
	 * @param {{ onSelect: (id:string)=>void, getCurrent: ()=>string, title?: string, subtitle?: string }} opts
	 */
	constructor(agents, opts) {
		this.agents = agents;
		this.onSelect = opts.onSelect;
		this.getCurrent = opts.getCurrent;
		this.title = opts.title || 'Choose your guide';
		this.subtitle = opts.subtitle || 'Pick the rigged 3D agent who shows you around. You can switch anytime.';
		this._root = null;
		this._lastFocus = null;
		this._onKey = this._onKey.bind(this);
		this._build();
	}

	/** @returns {string|null} persisted agent id, if any. */
	static restore() {
		try { return localStorage.getItem(STORE_KEY); } catch { return null; }
	}

	static persist(id) {
		try { localStorage.setItem(STORE_KEY, id); } catch { /* private mode */ }
	}

	_build() {
		const root = document.createElement('div');
		root.className = 'tw-pa-picker';
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', this.title);
		root.dataset.open = 'false';

		const panel = document.createElement('div');
		panel.className = 'tw-pa-panel';

		const close = document.createElement('button');
		close.className = 'tw-pa-btn tw-pa-close';
		close.setAttribute('aria-label', 'Close');
		close.innerHTML = icon('close');
		close.addEventListener('click', () => this.close());

		const h = document.createElement('h2');
		h.textContent = this.title;
		const sub = document.createElement('p');
		sub.className = 'tw-pa-sub';
		sub.textContent = this.subtitle;

		const grid = document.createElement('div');
		grid.className = 'tw-pa-grid';
		grid.setAttribute('role', 'listbox');
		grid.setAttribute('aria-label', 'Available agents');

		this._cards = [];
		for (const a of this.agents) {
			const card = document.createElement('button');
			card.className = 'tw-pa-card';
			card.type = 'button';
			card.setAttribute('role', 'option');
			card.dataset.id = a.id;
			card.style.setProperty('--tw-pa-accent2', a.accent);
			card.innerHTML = `
				<div class="tw-pa-swatch" aria-hidden="true">${STYLE_EMOJI[a.style] || '🧑'}</div>
				<span class="tw-pa-cname">${esc(a.name)}</span>
				<span class="tw-pa-ctag">${esc(a.tagline)}</span>
				<span class="tw-pa-chip">${esc(lipsyncLabel(a.lipsync))}</span>`;
			card.addEventListener('click', () => {
				AvatarPicker.persist(a.id);
				this.onSelect(a.id);
				this._mark();
				this.close();
			});
			this._cards.push(card);
			grid.appendChild(card);
		}

		panel.append(close, h, sub, grid);
		root.appendChild(panel);
		root.addEventListener('click', (e) => { if (e.target === root) this.close(); });

		this._root = root;
		this._grid = grid;
	}

	mount(parent = document.body) {
		if (!this._root.isConnected) parent.appendChild(this._root);
	}

	open() {
		this.mount();
		this._mark();
		this._lastFocus = document.activeElement;
		this._root.dataset.open = 'true';
		document.addEventListener('keydown', this._onKey, true);
		const current = this._cards.find((c) => c.getAttribute('aria-current') === 'true') || this._cards[0];
		current?.focus();
	}

	close() {
		this._root.dataset.open = 'false';
		document.removeEventListener('keydown', this._onKey, true);
		if (this._lastFocus?.focus) this._lastFocus.focus();
	}

	get isOpen() {
		return this._root?.dataset.open === 'true';
	}

	_mark() {
		const cur = this.getCurrent();
		for (const c of this._cards) c.setAttribute('aria-current', String(c.dataset.id === cur));
	}

	_onKey(e) {
		if (!this.isOpen) return;
		if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
		const focusables = this._cards.concat(this._root.querySelector('.tw-pa-close'));
		const idx = focusables.indexOf(document.activeElement);
		if (e.key === 'Tab') {
			e.preventDefault();
			const dir = e.shiftKey ? -1 : 1;
			const next = (idx + dir + focusables.length) % focusables.length;
			focusables[next]?.focus();
		} else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
			e.preventDefault();
			const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
			const cardIdx = this._cards.indexOf(document.activeElement);
			const base = cardIdx < 0 ? 0 : cardIdx;
			const next = (base + dir + this._cards.length) % this._cards.length;
			this._cards[next]?.focus();
		}
	}

	dispose() {
		document.removeEventListener('keydown', this._onKey, true);
		this._root?.remove();
	}
}

function lipsyncLabel(mode) {
	return mode === 'viseme' ? 'Viseme lipsync' : mode === 'jaw' ? 'Jaw lipsync' : 'Full-body';
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function icon(name) {
	if (name === 'close') {
		return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
	}
	return '';
}
