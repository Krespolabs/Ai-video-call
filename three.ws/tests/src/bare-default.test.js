// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// The element pulls in a WebGL Viewer and the dat.GUI debug panel on boot.
// Neither survives jsdom, and we only care about which chrome the shell builds,
// so stub both. boot() will still no-op-fail on the stubbed viewer — that's
// fine; _renderShell (the thing under test) runs synchronously before boot.
vi.mock('../../src/viewer.js', () => ({ Viewer: class {} }));
vi.mock('dat.gui', () => ({
	GUI: class {
		addFolder() { return this; }
		add() { return { onChange: () => this, name: () => this }; }
		addColor() { return { onChange: () => this, name: () => this }; }
		destroy() {}
	},
}));

import '../../src/element.js';

describe('<agent-3d> chrome policy', () => {
	it('a plain element is a bare, transparent avatar — no chat chrome', () => {
		const el = document.createElement('agent-3d');
		document.body.appendChild(el);
		const sr = el.shadowRoot;
		const has = (sel) => !!sr.querySelector(sel);

		// The avatar canvas host is always present…
		expect(has('.stage')).toBe(true);
		// …but none of the conversational chrome is built by default.
		expect(has('.chrome')).toBe(false);
		expect(has('.chat')).toBe(false);
		expect(has('.input-row')).toBe(false);
		expect(has('.icon.mic')).toBe(false);
		expect(has('.thought-bubble')).toBe(false);

		// Bare mode is reflected for CSS (hides debug GUI / axes) and the
		// background composites transparently by default.
		expect(el.hasAttribute('data-bare')).toBe(true);
		expect(el.getAttribute('background') || 'transparent').toBe('transparent');
	});

	it('the `chat` attribute opts into the full conversational chrome', () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('chat', '');
		document.body.appendChild(el);

		expect(!!el.shadowRoot.querySelector('.chat')).toBe(true);
		expect(el.hasAttribute('data-bare')).toBe(false);
	});

	it('binding a published agent (agent-id) talks by default', () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('agent-id', '11111111-1111-1111-1111-111111111111');
		document.body.appendChild(el);

		expect(!!el.shadowRoot.querySelector('.chat')).toBe(true);
		expect(el.hasAttribute('data-bare')).toBe(false);
	});

	it('`viewer` forces a bound agent back to bare decoration', () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('agent-id', '11111111-1111-1111-1111-111111111111');
		el.setAttribute('viewer', '');
		document.body.appendChild(el);

		expect(!!el.shadowRoot.querySelector('.chat')).toBe(false);
		expect(el.hasAttribute('data-bare')).toBe(true);
	});
});
