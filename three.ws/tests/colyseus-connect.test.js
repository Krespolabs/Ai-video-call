// joinRoomWithTimeout — the bounded room join shared by every multiplayer client
// (community-net, walk-net, irl-net). Colyseus's joinOrCreate never times out the
// post-open JOIN_ROOM handshake, so a hung handshake would strand a client in a
// terminal 'connecting' state forever. These lock in that the helper either
// returns the room in time, or throws 'connect_timeout' AND leaves a room that
// resolves too late (so a zombie handshake can't orphan a second live socket).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { joinRoomWithTimeout, CONNECT_TIMEOUT_MS } from '../src/shared/colyseus-connect.js';

// A fake Colyseus client whose joinOrCreate resolves/rejects/hangs on command.
function clientThatJoins(behaviour) {
	return { joinOrCreate: vi.fn(() => behaviour()) };
}

describe('joinRoomWithTimeout', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('returns the room when the join resolves before the deadline', async () => {
		const room = { id: 'r1', leave: vi.fn() };
		const client = clientThatJoins(() => Promise.resolve(room));

		const p = joinRoomWithTimeout(client, 'walk_world', { coin: '' }, {});
		await expect(p).resolves.toBe(room);
		expect(client.joinOrCreate).toHaveBeenCalledWith('walk_world', { coin: '' }, {});
		expect(room.leave).not.toHaveBeenCalled();
	});

	it('throws connect_timeout when the handshake never completes', async () => {
		// A join that never settles — the exact stuck-on-connecting case.
		const client = clientThatJoins(() => new Promise(() => {}));

		const p = joinRoomWithTimeout(client, 'walk_world', {}, {}, 15_000);
		const assertion = expect(p).rejects.toThrow('connect_timeout');
		await vi.advanceTimersByTimeAsync(15_000);
		await assertion;
	});

	it('leaves a room that resolves AFTER the timeout fired (no orphaned socket)', async () => {
		const room = { id: 'late', leave: vi.fn() };
		let resolveJoin;
		const client = clientThatJoins(() => new Promise((res) => { resolveJoin = res; }));

		const p = joinRoomWithTimeout(client, 'walk_world', {}, {}, 5_000);
		const assertion = expect(p).rejects.toThrow('connect_timeout');
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;

		// The zombie handshake completes late — its room must be left, not leaked.
		resolveJoin(room);
		await vi.advanceTimersByTimeAsync(0);
		expect(room.leave).toHaveBeenCalledTimes(1);
	});

	it('propagates a real join rejection unchanged (not masked as a timeout)', async () => {
		const client = clientThatJoins(() => Promise.reject(new Error('4215: room locked')));

		await expect(joinRoomWithTimeout(client, 'walk_world', {}, {})).rejects.toThrow('4215: room locked');
	});

	it('defaults to the shared CONNECT_TIMEOUT_MS deadline', async () => {
		const client = clientThatJoins(() => new Promise(() => {}));

		const p = joinRoomWithTimeout(client, 'walk_world', {}, {});
		const assertion = expect(p).rejects.toThrow('connect_timeout');
		await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
		await assertion;
	});
});
