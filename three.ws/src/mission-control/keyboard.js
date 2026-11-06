/**
 * Mission Control — keyboard controller + shortcut overlay.
 *
 * Keyboard-first cockpit. Movement and trading never require the mouse:
 *   j / ↓ · k / ↑   move the selection through the visible feed
 *   b · s           buy the preset size · sell the whole position
 *   1…6             pick a buy-size preset
 *   /               focus the feed filter
 *   x               toggle express mode (confirm-on-first-use ↔ instant)
 *   ?               this overlay   ·   Esc closes it / clears selection
 *
 * Shortcuts are suppressed while typing in an input so the filter box behaves.
 */

import { toast } from './ui.js';
import { escapeHtml } from './format.js';

const SHORTCUTS = [
	['j  /  ↓', 'Next launch'],
	['k  /  ↑', 'Previous launch'],
	['b', 'Buy preset size'],
	['s', 'Sell entire position'],
	['1 – 6', 'Choose buy size'],
	['/', 'Filter the feed'],
	['x', 'Toggle express trading'],
	['g', 'Jump to top of feed'],
	['?', 'Show / hide this help'],
	['Esc', 'Close help · clear selection'],
];

export function createKeyboard({ store, bus, feed }) {
	let overlay = null;

	function isEditable(el) {
		if (!el) return false;
		const tag = el.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
	}

	function move(delta) {
		const rows = store.visibleRows();
		if (!rows.length) return;
		const cur = store.getSelected();
		let idx = rows.findIndex((r) => r.mint === cur);
		if (idx < 0) idx = delta > 0 ? -1 : 0;
		const next = Math.max(0, Math.min(rows.length - 1, idx + delta));
		store.select(rows[next].mint);
	}

	function chooseSize(n) {
		const presets = store.getPresets();
		if (presets[n - 1] != null) store.setActiveSize(presets[n - 1]);
	}

	function toggleOverlay(force) {
		const show = force != null ? force : !overlay;
		if (show && !overlay) {
			overlay = document.createElement('div');
			overlay.className = 'mc-overlay';
			overlay.setAttribute('role', 'dialog');
			overlay.setAttribute('aria-modal', 'true');
			overlay.setAttribute('aria-label', 'Keyboard shortcuts');
			overlay.innerHTML = `
				<div class="mc-overlay-card">
					<h2>Keyboard shortcuts</h2>
					<div class="mc-keys">
						${SHORTCUTS.map(([k, d]) => `<div class="mc-keyrow"><span>${escapeHtml(d)}</span><kbd>${escapeHtml(k)}</kbd></div>`).join('')}
					</div>
					<p style="margin:16px 0 0;color:var(--ink-faint,#666);font-size:.72rem">Every trade runs through the firewall + MEV engine and is signed by your agent wallet, spend-guarded and audited. $THREE is the only coin three.ws promotes — every other mint here is live market data.</p>
				</div>`;
			overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) toggleOverlay(false); });
			document.body.appendChild(overlay);
		} else if (!show && overlay) {
			overlay.remove();
			overlay = null;
		}
	}

	function onKey(e) {
		// Always allow Escape to close the overlay, even from an input.
		if (e.key === 'Escape') {
			if (overlay) { toggleOverlay(false); e.preventDefault(); return; }
			if (isEditable(e.target)) { e.target.blur(); return; }
			return;
		}
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (isEditable(e.target)) return;
		if (overlay && e.key !== '?') { /* let ? toggle; other keys close */ if (e.key !== 'Escape') { toggleOverlay(false); } }

		switch (e.key) {
			case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
			case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
			case 'b': e.preventDefault(); requireSelection() && bus.emit('action:buy'); break;
			case 's': e.preventDefault(); requireSelection() && bus.emit('action:sell'); break;
			case '/': e.preventDefault(); feed?.focusSearch?.(); break;
			case 'g': e.preventDefault(); feed?.scrollTop?.(); break;
			case '?': e.preventDefault(); toggleOverlay(); break;
			case 'x': {
				e.preventDefault();
				const agent = store.getAgent();
				if (!agent) { toast('Select an agent first.', { tone: 'warn' }); break; }
				const on = store.toggleExpress(agent.id);
				toast(on ? 'Express trading on — buys & sells execute instantly.' : 'Express off — each trade asks once more.', { tone: on ? 'warn' : 'info' });
				break;
			}
			default:
				if (/^[1-6]$/.test(e.key)) { e.preventDefault(); chooseSize(Number(e.key)); }
		}
	}

	function requireSelection() {
		if (store.getSelected()) return true;
		const rows = store.visibleRows();
		if (rows.length) { store.select(rows[0].mint); }
		toast('Pick a coin first (j / k to move).', { tone: 'info', ms: 1800 });
		return false;
	}

	document.addEventListener('keydown', onKey);

	return {
		openHelp: () => toggleOverlay(true),
		destroy() {
			document.removeEventListener('keydown', onKey);
			if (overlay) { overlay.remove(); overlay = null; }
		},
	};
}
