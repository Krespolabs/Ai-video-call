// Regression: tearing down the PumpPortal WS before its handshake completes
// must not surface the benign "WebSocket was closed before the connection was
// established" error. This is the common serverless path — the alpha-candidates
// endpoint taps the feed on a short timer (collectLiveMints) and aborts it,
// frequently while the upstream socket is still CONNECTING.
//
// The fake `ws` mirrors the real library: close()/terminate() on a CONNECTING
// socket aborts the handshake and emits 'error' (premature-close) then 'close'
// asynchronously, to whatever listeners are registered at emit time.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PREMATURE = 'WebSocket was closed before the connection was established';

class FakeWS {
	constructor(url) {
		this.url = url;
		this.readyState = 0; // CONNECTING — never transitions to OPEN here
		this._h = {};
		FakeWS.instances.push(this);
	}
	on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
	removeAllListeners(ev) { if (ev) delete this._h[ev]; else this._h = {}; return this; }
	emit(ev, ...a) { (this._h[ev] || []).forEach((cb) => cb(...a)); }
	send() {}
	terminate() { this._abortHandshake(); }
	close() { if (this.readyState === 0) this._abortHandshake(); else this.emit('close'); }
	_abortHandshake() {
		this.readyState = 2; // CLOSING
		// Real ws emits on process.nextTick — defer so listeners registered during
		// teardown (the no-op error swallow) are the ones that receive it.
		queueMicrotask(() => {
			this.emit('error', new Error(PREMATURE));
			this.emit('close');
		});
	}
}
FakeWS.instances = [];

vi.mock('ws', () => ({ default: FakeWS }));

// Keep the REST mint fallback inert (kind:'mint' kicks off a poll on connect).
globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }));

const { connectPumpFunFeed } = await import('../api/_lib/pumpfun-ws-feed.js');

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('connectPumpFunFeed — teardown mid-handshake', () => {
	let warnSpy;
	beforeEach(() => {
		FakeWS.instances.length = 0;
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => warnSpy.mockRestore());

	it('does not log a premature-close error when stopped while CONNECTING', async () => {
		const stop = connectPumpFunFeed({ kind: 'mint', mints: [], onEvent: () => {} });
		const ws = FakeWS.instances[0];
		expect(ws.readyState).toBe(0); // still connecting — no open() emitted
		stop();
		await settle();
		const logged = warnSpy.mock.calls.some((c) => String(c.join(' ')).includes(PREMATURE));
		expect(logged).toBe(false);
	});

	it('does not log a premature-close error when aborted via the signal', async () => {
		const ac = new AbortController();
		connectPumpFunFeed({ kind: 'mint', mints: [], signal: ac.signal, onEvent: () => {} });
		const ws = FakeWS.instances[0];
		expect(ws.readyState).toBe(0);
		ac.abort();
		await settle();
		const logged = warnSpy.mock.calls.some((c) => String(c.join(' ')).includes(PREMATURE));
		expect(logged).toBe(false);
	});
});
