// Regression: the zauth SDK's flush() early-returns while a previous batch
// is submitting (`isFlushing`) and nothing re-triggers it, so the response
// event — queued at res.end while the request-event batch is still POSTing —
// was stranded in the queue and dropped when Vercel froze the lambda.
// Confirmed in production runtime logs (request batches logged
// "Batch submitted", response events only ever logged "Event queued").
// drain() must deliver BOTH events before resolving.
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, expect, test } from 'vitest';

const telemetryBodies = [];
let releaseFirstBatch;
const firstBatchGate = new Promise((resolve) => {
	releaseFirstBatch = resolve;
});

const realFetch = globalThis.fetch;

beforeAll(() => {
	process.env.ZAUTH_API_KEY = 'zauth_sk_test_drain_regression';
	process.env.ZAUTH_DRAIN_MAX_MS = '5000';
	// Replace fetch BEFORE the adapter wraps it: zauth-bound POSTs are recorded
	// and the FIRST one is held open until released, recreating the window in
	// which the SDK strands the next queued event.
	globalThis.fetch = async (url, init) => {
		const u = typeof url === 'string' ? url : url?.url || String(url);
		if (/zauthx402\.com/i.test(u)) {
			const body = JSON.parse(init.body);
			telemetryBodies.push(body);
			if (telemetryBodies.length === 1) await firstBatchGate;
			return new Response(JSON.stringify({ ok: true, accepted: body.events.length }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		return realFetch(url, init);
	};
});

afterAll(() => {
	globalThis.fetch = realFetch;
});

function makeReq(path) {
	return {
		url: path,
		method: 'GET',
		// x-payment marks this as a real payment attempt — only those are
		// monitored on /api/x402/* paths (unpaid 402 challenges are not).
		headers: {
			host: 'three.ws',
			'x-forwarded-proto': 'https',
			'x-payment': Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64'),
		},
		socket: { remoteAddress: '203.0.113.7' },
	};
}

function makeRes() {
	const res = new EventEmitter();
	const headersStore = {};
	res.statusCode = 200;
	res.headersSent = false;
	res.writableEnded = false;
	res.setHeader = (k, v) => {
		headersStore[String(k).toLowerCase()] = v;
	};
	res.getHeader = (k) => headersStore[String(k).toLowerCase()];
	res.getHeaders = () => ({ ...headersStore });
	res.removeHeader = (k) => delete headersStore[String(k).toLowerCase()];
	res.write = () => true;
	res.end = function end(body) {
		void body;
		res.writableEnded = true;
		res.headersSent = true;
		res.emit('finish');
		res.emit('close');
		return res;
	};
	return res;
}

test('unpaid x402 requests are not monitored — 402 challenges must not report as failed calls', async () => {
	const { instrument } = await import('../api/_lib/zauth.js');

	const req = makeReq('/api/x402/model-check');
	delete req.headers['x-payment'];
	const res = makeRes();
	expect(instrument(req, res)).toBe(false);
});

test('drain delivers the response event stranded behind an in-flight batch', async () => {
	const { instrument, drain, ensureReady } = await import('../api/_lib/zauth.js');

	// The SDK now loads lazily (kept off the esbuild/NFT static graph so it
	// isn't bundled into every route) — warm it before asserting instrumentation.
	await ensureReady();

	const req = makeReq('/api/x402/model-check');
	const res = makeRes();
	expect(instrument(req, res)).toBe(true);

	res.statusCode = 402;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ error: 'payment required' }));

	// Let the request-event batch start its POST (held open by the gate),
	// then release it only once drain is underway — drain must then re-flush
	// the stranded response event rather than returning after batch #1.
	const drained = drain();
	setTimeout(() => releaseFirstBatch(), 100);
	await drained;

	const eventTypes = telemetryBodies.flatMap((b) => b.events.map((e) => e.type));
	expect(eventTypes).toContain('request');
	expect(eventTypes).toContain('response');
	expect(telemetryBodies.length).toBeGreaterThanOrEqual(2);
});
