// Integration-flavored test for /api/club/tips/stream — spins the handler
// up on a real local HTTP server, opens an SSE consumer via fetch(), seeds
// rows through the mocked `sql` template, and asserts the consumer receives
// a `tip` event with the inserted ticket_id within one poll cadence.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

const sqlState = {
	queue: [],
	calls: [],
};

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const query = typeof strings === 'string' ? strings : strings.join('?');
		sqlState.calls.push({ query, values });
		return sqlState.queue.length === 0 ? [] : sqlState.queue.shift();
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { default: handler } = await import('../../api/club/tips-stream.js');

let server;
let baseUrl;
let controllers = [];

beforeEach(async () => {
	sqlState.queue = [];
	sqlState.calls = [];
	server = createServer((req, res) => {
		// Vercel handlers get `req.query` populated for them by the platform —
		// we mimic that here, although tips-stream doesn't use any query params.
		req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
		handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
	for (const c of controllers) {
		try { c.abort(); } catch {}
	}
	controllers = [];
	await new Promise((resolve) => server.close(resolve));
});

// Stateful SSE parser bound to one response body. Returns an object with a
// `waitFor(eventName, timeoutMs)` method that consumes frames from the
// stream until the requested event arrives. Sharing a single reader avoids
// the "ReadableStream is locked" error you get from calling getReader()
// twice on the same body.
function makeSseConsumer(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const pending = []; // FIFO of parsed { event, data } frames
	let buffer = '';
	let streamDone = false;

	const drainBuffer = () => {
		let idx;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const frame = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			if (frame.startsWith(':')) continue; // heartbeat comment
			let event = 'message';
			let data = '';
			for (const line of frame.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) data += line.slice(5).trim();
			}
			pending.push({ event, data });
		}
	};

	const readChunk = async (timeoutMs) => {
		const timer = new Promise((resolve) =>
			setTimeout(() => resolve({ done: true, value: null, timedOut: true }), timeoutMs),
		);
		const result = await Promise.race([reader.read(), timer]);
		if (result.timedOut) return false;
		if (result.done) { streamDone = true; return false; }
		buffer += decoder.decode(result.value, { stream: true });
		drainBuffer();
		return true;
	};

	return {
		async waitFor(eventName, timeoutMs = 4000) {
			const deadline = Date.now() + timeoutMs;
			while (true) {
				const idx = pending.findIndex((p) => p.event === eventName);
				if (idx !== -1) {
					const frame = pending.splice(idx, 1)[0];
					try { return JSON.parse(frame.data); } catch { return frame.data; }
				}
				if (streamDone) {
					throw new Error(`stream ended before "${eventName}" event`);
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					throw new Error(`timed out waiting for SSE event "${eventName}"`);
				}
				await readChunk(remaining);
			}
		},
		close() {
			try { reader.cancel(); } catch {}
		},
	};
}

describe('GET /api/club/tips/stream', () => {
	it('emits a `hello` frame as soon as the connection opens', async () => {
		const controller = new AbortController();
		controllers.push(controller);
		const r = await fetch(`${baseUrl}/api/club/tips/stream`, { signal: controller.signal });
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
		expect(r.headers.get('x-accel-buffering')).toBe('no');
		const sse = makeSseConsumer(r.body);
		try {
			const hello = await sse.waitFor('hello', 2000);
			expect(hello).toHaveProperty('ts');
		} finally {
			sse.close();
			controller.abort();
		}
	});

	it('delivers a `tip` event when a new club_tips row appears', async () => {
		const controller = new AbortController();
		controllers.push(controller);
		const r = await fetch(`${baseUrl}/api/club/tips/stream`, { signal: controller.signal });
		const sse = makeSseConsumer(r.body);
		try {
			// Wait for hello so we know the stream is established + the poller
			// has registered its initial cursor.
			await sse.waitFor('hello', 2000);

			// Seed a row that will be picked up on the next poll. created_at is
			// far in the future so the cursor comparison fires regardless of
			// clock skew between the test and the handler.
			const row = {
				ticket_id: 'stream-1',
				dancer: '3',
				dance: 'silly',
				clip: 'silly',
				label: 'Silly',
				payer: '0xfeed',
				network: 'base',
				amount_atomics: '1000',
				asset: '0xUSDC',
				started_at: new Date('2030-01-01T00:00:00Z'),
				ends_at: new Date('2030-01-01T00:00:10Z'),
				created_at: new Date('2030-01-01T00:00:00.500Z'),
			};
			sqlState.queue.push([row]);

			const event = await sse.waitFor('tip', 3000);
			expect(event.ticket_id).toBe('stream-1');
			expect(event.dancer).toBe('3');
			expect(event.dance).toBe('silly');
		} finally {
			sse.close();
			controller.abort();
		}
	});

	it('rejects non-GET methods with 405', async () => {
		const r = await fetch(`${baseUrl}/api/club/tips/stream`, { method: 'POST' });
		expect(r.status).toBe(405);
		await r.body?.cancel();
	});

	it('handles OPTIONS preflight without opening a stream', async () => {
		const r = await fetch(`${baseUrl}/api/club/tips/stream`, {
			method: 'OPTIONS',
			headers: { origin: 'https://example.com' },
		});
		expect(r.status).toBe(204);
		await r.body?.cancel();
	});
});
