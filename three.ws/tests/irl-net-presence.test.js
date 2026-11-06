// D2 — the client's presence derivation. _emitPresence() turns the room's live
// `viewers` MapSchema into the { count, viewers } the HUD reads: count is the whole
// crowd (self included), but the rendered viewer list is ONLY other opted-in
// ghosts (self + count-only entries filtered out, so a marker is never drawn for
// someone who didn't opt to be seen, nor for yourself).

import { describe, it, expect } from 'vitest';

import { IrlNet } from '../src/irl-net.js';

function viewer(over = {}) {
	return { lat: 1, lng: 2, heading: 0, avatar: '', ghost: false, ...over };
}

// Stand up an IrlNet with a fake live room whose state.viewers is a plain Map
// (same forEach(value, key) shape as a colyseus MapSchema).
function netWith(entries, selfId) {
	const net = new IrlNet({ lat: 0, lng: 0, url: '' });
	net.room = { sessionId: selfId, state: { viewers: new Map(entries) } };
	let captured = null;
	net.on('presence', (p) => { captured = p; });
	net._emitPresence();
	return captured;
}

describe('IrlNet._emitPresence', () => {
	it('counts everyone but renders only OTHER opted-in ghosts', () => {
		const p = netWith([
			['self', viewer({ ghost: true })],          // me — counted, never rendered
			['a', viewer({ ghost: true, avatar: 'a.glb', glat: undefined, lat: 10, lng: 20, heading: 90 })],
			['b', viewer({ ghost: false })],            // count-only — never rendered
		], 'self');

		expect(p.count).toBe(3);
		expect(p.viewers).toHaveLength(1);
		expect(p.viewers[0]).toMatchObject({ id: 'a', glat: 10, glng: 20, heading: 90, avatar: 'a.glb', ghost: true });
	});

	it('emits a zero/empty payload cleanly when only self is present', () => {
		const p = netWith([['self', viewer({ ghost: true })]], 'self');
		expect(p.count).toBe(1);
		expect(p.viewers).toEqual([]);
	});
});

describe('IrlNet.heartbeat / setGhost guards', () => {
	it('are safe no-ops when no live socket is present', () => {
		const net = new IrlNet({ lat: 0, lng: 0, url: '' });
		expect(() => net.heartbeat(123)).not.toThrow();
		// setGhost still records intent for the next connect, even offline.
		net.setGhost(true, 'x.glb');
		expect(net.ghost).toBe(true);
		expect(net.avatar).toBe('x.glb');
	});
});
