// @vitest-environment jsdom
//
// Verifies the LobeChat / SperaxOS standalone-plugin protocol handling inside
// the embed iframe boot script (public/lobehub/iframe/boot.js). The host posts
// `<ns>:init-standalone-plugin` tool calls; boot.js must parse apiName + the
// JSON-string arguments and drive the <agent-3d> element, and must announce
// readiness on both the `lobe-chat:` and `speraxos:` channels.
import { describe, it, expect, vi, beforeAll } from 'vitest';

describe('chat plugin protocol (boot.js) — LobeChat / SperaxOS', () => {
	let el;
	let parentPost;
	let bootPosts;

	beforeAll(async () => {
		document.body.innerHTML = '<div id="status"></div>';
		el = document.createElement('agent-3d');
		el.id = 'agent';
		document.body.appendChild(el);
		el.speak = vi.fn();
		el.play = vi.fn().mockResolvedValue(undefined);
		el.wave = vi.fn().mockResolvedValue(undefined);
		const realDispatch = el.dispatchEvent.bind(el);
		el.dispatchEvent = vi.fn(realDispatch);

		// window.parent === window in jsdom; record outbound posts without
		// re-dispatching them back into the listener.
		parentPost = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

		// Executes boot.js side effects: registers the message listener and
		// announces readiness.
		await import('../public/lobehub/iframe/boot.js');
		// Vitest clears mock history before every test, so keep what boot posted.
		bootPosts = parentPost.mock.calls.map((c) => c[0]);
	});

	// A host message, with event.source pinned to the parent window (boot.js
	// requires ev.source === window.parent).
	function hostSend(type, body) {
		const ev = new MessageEvent('message', {
			data: { type, ...body },
			origin: 'https://chat.sperax.io',
		});
		Object.defineProperty(ev, 'source', { value: window, configurable: true });
		window.dispatchEvent(ev);
	}

	function toolCall(ns, apiName, args, settings) {
		hostSend(`${ns}:init-standalone-plugin`, {
			payload: { identifier: 'three-ws', apiName, arguments: JSON.stringify(args) },
			...(settings ? { settings } : {}),
		});
	}

	it('announces plugin-ready on both channels at boot', () => {
		const types = bootPosts.map((m) => m && m.type);
		expect(types).toContain('lobe-chat:plugin-ready-for-render');
		expect(types).toContain('speraxos:plugin-ready-for-render');
	});

	it('drives speak from a speraxos init-standalone-plugin call', () => {
		toolCall('speraxos', 'speak', { text: 'gm', sentiment: 0.5 });
		expect(el.speak).toHaveBeenCalledWith('gm', { sentiment: 0.5 });
	});

	it('accepts the lobe-chat: prefix identically', () => {
		el.speak.mockClear();
		toolCall('lobe-chat', 'speak', { text: 'hi' });
		expect(el.speak).toHaveBeenCalledWith('hi', { sentiment: 0 });
	});

	it('binds the agent from settings.agentId', () => {
		toolCall('speraxos', 'speak', { text: 'x' }, { agentId: 'agent-123' });
		expect(el.getAttribute('agent-id')).toBe('agent-123');
	});

	it('binds the agent from a render_agent call', () => {
		toolCall('speraxos', 'render_agent', { agentId: 'agent-999' });
		expect(el.getAttribute('agent-id')).toBe('agent-999');
	});

	it('plays a named gesture', () => {
		toolCall('speraxos', 'gesture', { name: 'wave' });
		expect(el.wave).toHaveBeenCalled();
	});

	it('dispatches emote as an agent:action CustomEvent', () => {
		el.dispatchEvent.mockClear();
		toolCall('speraxos', 'emote', { trigger: 'celebration', weight: 0.8 });
		const evt = el.dispatchEvent.mock.calls.at(-1)?.[0];
		expect(evt?.type).toBe('agent:action');
		expect(evt?.detail).toMatchObject({
			type: 'emote',
			payload: { trigger: 'celebration', weight: 0.8 },
		});
	});

	it('parses an already-parsed arguments object (defensive)', () => {
		el.speak.mockClear();
		hostSend('speraxos:init-standalone-plugin', {
			payload: { apiName: 'speak', arguments: { text: 'obj-args', sentiment: -0.3 } },
		});
		expect(el.speak).toHaveBeenCalledWith('obj-args', { sentiment: -0.3 });
	});

	it('ignores unrelated plugin channels', () => {
		el.speak.mockClear();
		hostSend('speraxos:render-plugin-state', { payload: {} });
		expect(el.speak).not.toHaveBeenCalled();
	});
});
