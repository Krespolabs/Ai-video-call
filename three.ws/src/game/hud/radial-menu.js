// RadialMenu — a GTA-style radial selector used for both the interaction menu
// ("M") and the weapon/action wheel (hold-to-open). One component, two configs.
//
// It renders an SVG ring of wedges around a centre hub, and resolves a focused
// item from mouse angle, arrow keys, number keys, touch drag, or a gamepad
// stick. Two open styles:
//   - 'toggle' (interaction menu): opens, you click/Enter a wedge, it closes.
//   - 'hold'   (weapon wheel): opens while a key is held; the wedge under the
//     pointer/stick is committed on release. GTA's weapon wheel feel.
//
// Fully keyboard- + touch- + gamepad-navigable, design-token themed, and self
// contained — the host just calls open()/close() and gets an onSelect(item).

import './radial-menu.css';

const TAU = Math.PI * 2;

// Annular-sector path between inner radius `ri` and outer `ro`, sweeping a0→a1.
function wedgePath(cx, cy, ri, ro, a0, a1) {
	const pt = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
	const large = (a1 - a0) % TAU > Math.PI ? 1 : 0;
	return `M ${pt(ro, a0)} A ${ro} ${ro} 0 ${large} 1 ${pt(ro, a1)} L ${pt(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${pt(ri, a0)} Z`;
}

export class RadialMenu {
	/**
	 * @param {object} opts
	 * @param {string} [opts.id]        DOM id for the overlay (default 'wh-radial')
	 * @param {string} [opts.title]     centre-hub title shown when nothing is focused
	 * @param {'toggle'|'hold'} [opts.mode]  open style (default 'toggle')
	 * @param {(item:object)=>void} opts.onSelect  committed selection callback
	 * @param {()=>void} [opts.onClose] fired whenever the menu closes
	 */
	constructor({ id = 'wh-radial', title = '', mode = 'toggle', onSelect, onClose } = {}) {
		this.id = id;
		this.title = title;
		this.mode = mode;
		this.onSelect = onSelect || (() => {});
		this.onClose = onClose || (() => {});
		this.items = [];
		this.focus = -1;          // index of the focused wedge, -1 = hub/cancel
		this.isOpen = false;
		this._ns = 'http://www.w3.org/2000/svg';
		this._size = 360;          // SVG viewBox units; CSS scales it responsively
		this._ri = 70;             // inner (hub) radius
		this._ro = 168;            // outer radius
		this._padBoot = false;
		this._build();
		this._bind();
	}

	_build() {
		const root = document.createElement('div');
		root.id = this.id;
		root.className = 'wh-radial';
		root.setAttribute('role', 'menu');
		root.setAttribute('aria-hidden', 'true');
		root.hidden = true;

		const stage = document.createElement('div');
		stage.className = 'wh-radial-stage';

		const svg = document.createElementNS(this._ns, 'svg');
		svg.setAttribute('viewBox', `0 0 ${this._size} ${this._size}`);
		svg.setAttribute('class', 'wh-radial-svg');
		this._wedgeLayer = document.createElementNS(this._ns, 'g');
		this._labelLayer = document.createElementNS(this._ns, 'g');
		svg.append(this._wedgeLayer, this._labelLayer);

		// Centre hub: shows the focused item's label, or the menu title / "Close".
		const hub = document.createElement('div');
		hub.className = 'wh-radial-hub';
		this._hubIcon = document.createElement('div');
		this._hubIcon.className = 'wh-radial-hub-icon';
		this._hubLabel = document.createElement('div');
		this._hubLabel.className = 'wh-radial-hub-label';
		this._hubHint = document.createElement('div');
		this._hubHint.className = 'wh-radial-hub-hint';
		hub.append(this._hubIcon, this._hubLabel, this._hubHint);

		stage.append(svg, hub);
		root.append(stage);
		document.body.appendChild(root);
		this.root = root;
		this.stage = stage;
		this.svg = svg;
		this.hub = hub;
	}

	_bind() {
		// Pointer angle → focused wedge. Listen on the whole overlay so the cursor
		// can be anywhere; the centre deadzone reads as "cancel".
		this.root.addEventListener('pointermove', (e) => {
			if (!this.isOpen) return;
			const rect = this.stage.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const dx = e.clientX - cx, dy = e.clientY - cy;
			const dist = Math.hypot(dx, dy);
			const dead = rect.width * (this._ri / this._size) * 0.62;
			if (dist < dead) { this._setFocus(-1); return; }
			this._setFocus(this._indexForAngle(Math.atan2(dy, dx)));
		});
		// Tap/click a wedge to commit (works in both modes so touch can drive the
		// hold-style wheels); a tap on the hub/centre cancels.
		this.root.addEventListener('pointerup', (e) => {
			if (!this.isOpen || !this._pointerEngaged) return;
			this._pointerEngaged = false;
			if (this.focus >= 0) this._commit();
			else this.close();
			e.stopPropagation();
		});
		// A press inside the ring arms a tap-commit; a press on the backdrop closes.
		this.root.addEventListener('pointerdown', (e) => {
			if (e.target === this.root) { this.close(); return; }
			this._pointerEngaged = true;
			// Touch has no hover — seed focus from the press angle.
			const rect = this.stage.getBoundingClientRect();
			const dx = e.clientX - (rect.left + rect.width / 2), dy = e.clientY - (rect.top + rect.height / 2);
			if (Math.hypot(dx, dy) >= rect.width * (this._ri / this._size) * 0.62) this._setFocus(this._indexForAngle(Math.atan2(dy, dx)));
		});
	}

	// Which wedge centre is nearest this pointer angle (screen space, +x right,
	// +y down). Wedge i is centred at the top + i steps clockwise.
	_indexForAngle(angle) {
		const n = this.items.length;
		if (!n) return -1;
		// Shift so 0 maps to straight up (−90°), then quantise to the nearest slot.
		let a = angle + Math.PI / 2;
		a = ((a % TAU) + TAU) % TAU;
		return Math.round(a / (TAU / n)) % n;
	}

	setTitle(title) { this.title = title || ''; }

	setItems(items) {
		this.items = (items || []).filter((it) => it && !it.hidden);
		if (this.isOpen) this._render();
	}

	open(items) {
		if (items) this.setItems(items);
		if (!this.items.length) return;
		this.isOpen = true;
		this.focus = -1;
		this.root.hidden = false;
		this.root.setAttribute('aria-hidden', 'false');
		this._render();
		// Let the enter transition run from the next frame.
		requestAnimationFrame(() => this.root.classList.add('is-open'));
		this._startGamepad();
		document.addEventListener('keydown', this._onKey, true);
	}

	close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.root.classList.remove('is-open');
		this.root.setAttribute('aria-hidden', 'true');
		this._stopGamepad();
		document.removeEventListener('keydown', this._onKey, true);
		// Hold until the exit transition finishes so it doesn't pop.
		clearTimeout(this._hideTimer);
		this._hideTimer = setTimeout(() => { if (!this.isOpen) this.root.hidden = true; }, 180);
		this.onClose();
	}

	// Commit the focused wedge (hold-mode release, click, or Enter).
	_commit() {
		const item = this.items[this.focus];
		this.close();
		if (item) { try { this.onSelect(item); } catch { /* host handles */ } }
	}

	// Hold-mode: release the open key → commit whatever is focused (if anything).
	release() {
		if (!this.isOpen) return;
		if (this.focus >= 0) this._commit();
		else this.close();
	}

	_setFocus(i) {
		if (i === this.focus) return;
		this.focus = i;
		this._paintFocus();
	}

	_paintFocus() {
		const wedges = this._wedgeLayer.children;
		for (let i = 0; i < wedges.length; i++) {
			wedges[i].classList.toggle('is-focus', i === this.focus);
		}
		const labels = this._labelLayer.children;
		for (let i = 0; i < labels.length; i++) {
			labels[i].classList.toggle('is-focus', i === this.focus);
		}
		const item = this.focus >= 0 ? this.items[this.focus] : null;
		if (item) {
			this._hubIcon.textContent = item.icon || '';
			this._hubLabel.textContent = item.label || '';
			this._hubHint.textContent = item.hint || '';
		} else {
			this._hubIcon.textContent = '';
			this._hubLabel.textContent = this.title || (this.mode === 'hold' ? 'Release to cancel' : 'Close');
			this._hubHint.textContent = '';
		}
	}

	_render() {
		const n = this.items.length;
		const c = this._size / 2;
		const gap = n > 1 ? 0.045 : 0;       // radians of breathing room between wedges
		const step = TAU / n;
		this._wedgeLayer.replaceChildren();
		this._labelLayer.replaceChildren();
		this.items.forEach((item, i) => {
			// Wedge i is centred straight up (−90°) + i steps clockwise.
			const mid = -Math.PI / 2 + i * step;
			const a0 = mid - step / 2 + gap / 2;
			const a1 = mid + step / 2 - gap / 2;
			const path = document.createElementNS(this._ns, 'path');
			path.setAttribute('d', wedgePath(c, c, this._ri, this._ro, a0, a1));
			path.setAttribute('class', 'wh-radial-wedge');
			if (item.color) path.style.setProperty('--wedge-accent', item.color);
			if (item.disabled) path.classList.add('is-disabled');
			path.setAttribute('role', 'menuitem');
			path.setAttribute('tabindex', '-1');
			path.setAttribute('aria-label', item.label || item.id || 'item');
			path.addEventListener('pointerenter', () => this._setFocus(i));
			this._wedgeLayer.appendChild(path);

			// Icon + short label riding the wedge at mid radius.
			const lr = (this._ri + this._ro) / 2;
			const lx = c + lr * Math.cos(mid);
			const ly = c + lr * Math.sin(mid);
			const g = document.createElementNS(this._ns, 'g');
			g.setAttribute('class', 'wh-radial-glabel');
			const icon = document.createElementNS(this._ns, 'text');
			icon.setAttribute('x', lx.toFixed(1));
			icon.setAttribute('y', (ly - 6).toFixed(1));
			icon.setAttribute('class', 'wh-radial-icon');
			icon.textContent = item.icon || '';
			const txt = document.createElementNS(this._ns, 'text');
			txt.setAttribute('x', lx.toFixed(1));
			txt.setAttribute('y', (ly + 20).toFixed(1));
			txt.setAttribute('class', 'wh-radial-text');
			txt.textContent = item.short || item.label || '';
			g.append(icon, txt);
			this._labelLayer.appendChild(g);
		});
		this._paintFocus();
	}

	// ----------------------------------------------------------------- keyboard
	_onKey = (e) => {
		if (!this.isOpen) return;
		const n = this.items.length;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			e.preventDefault(); e.stopPropagation();
			this._setFocus(((this.focus < 0 ? -1 : this.focus) + 1 + n) % n);
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			e.preventDefault(); e.stopPropagation();
			this._setFocus(((this.focus < 0 ? 1 : this.focus) - 1 + n) % n);
		} else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault(); e.stopPropagation();
			if (this.focus >= 0) this._commit();
		} else if (e.key >= '1' && e.key <= '9') {
			const i = Number(e.key) - 1;
			if (i < n) { e.preventDefault(); e.stopPropagation(); this._setFocus(i); if (this.mode === 'toggle') this._commit(); }
		}
	};

	// ------------------------------------------------------------------ gamepad
	// While open, poll the first connected pad: left stick steers focus, the
	// south/A button (0) confirms, B (1) / Start (9) cancels.
	_startGamepad() {
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
		this._padPrev = { confirm: false, cancel: false };
		const poll = () => {
			if (!this.isOpen) return;
			this._gamepadId = requestAnimationFrame(poll);
			const pads = navigator.getGamepads ? navigator.getGamepads() : [];
			const pad = [...pads].find(Boolean);
			if (!pad) return;
			const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
			if (Math.hypot(ax, ay) > 0.5) this._setFocus(this._indexForAngle(Math.atan2(ay, ax)));
			else if (this.mode === 'toggle') this._setFocus(-1);
			const confirm = !!(pad.buttons[0] && pad.buttons[0].pressed);
			const cancel = !!((pad.buttons[1] && pad.buttons[1].pressed) || (pad.buttons[9] && pad.buttons[9].pressed));
			if (confirm && !this._padPrev.confirm) { if (this.focus >= 0) this._commit(); }
			else if (cancel && !this._padPrev.cancel) this.close();
			this._padPrev = { confirm, cancel };
		};
		this._gamepadId = requestAnimationFrame(poll);
	}

	_stopGamepad() {
		if (this._gamepadId) cancelAnimationFrame(this._gamepadId);
		this._gamepadId = 0;
	}

	dispose() {
		this._stopGamepad();
		clearTimeout(this._hideTimer);
		document.removeEventListener('keydown', this._onKey, true);
		this.root?.remove();
	}
}
