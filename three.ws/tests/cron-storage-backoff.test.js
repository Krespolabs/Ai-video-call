/**
 * wrapCron storage-pressure preflight (requireWriteCapacity).
 *
 * The pump-intel firehose crons swallow their own per-row write failures, so at the
 * Neon project-size cap they kept ingesting and logging ~800 "could not extend file"
 * warnings per tick while persisting nothing (the production log storm). Opting a
 * write-heavy cron into `requireWriteCapacity` makes wrapCron probe storage first and
 * skip the whole tick with a healthy 200 when the branch is at its cap — so
 * db-retention can reclaim space and the next tick resumes. Contracts under test:
 *   1. pressured + flag → tick skipped (200 { ok:true, skipped }), handler NOT run.
 *   2. not pressured + flag → handler runs normally.
 *   3. no flag → never probes, handler always runs (unchanged legacy behavior).
 *   4. a probe fault fails OPEN — it must never stall a tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the DB module so we drive isStoragePressured without a live branch. http.js
// only pulls these three symbols from db.js; the classifiers stay inert here.
vi.mock('../api/_lib/db.js', () => ({
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: vi.fn(),
}));

import { wrapCron } from '../api/_lib/http.js';
import { isStoragePressured } from '../api/_lib/db.js';

// Minimal ServerResponse stand-in: case-insensitive header store + end capture.
function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

let warnSpy;
beforeEach(() => {
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	isStoragePressured.mockReset();
});
afterEach(() => {
	warnSpy.mockRestore();
});

const req = () => ({ method: 'GET', url: '/api/cron/coin-intel-observe', headers: {} });

describe('wrapCron requireWriteCapacity preflight', () => {
	it('skips the tick with a healthy 200 when the branch is at its storage cap', async () => {
		isStoragePressured.mockResolvedValue({ pressured: true, sizeMb: 511, highWaterMb: 470 });
		const handler = vi.fn(async (_req, res) => { res.statusCode = 200; res.end('{}'); });
		const wrapped = wrapCron(handler, { requireWriteCapacity: true });
		const res = fakeRes();

		await wrapped(req(), res);

		expect(handler).not.toHaveBeenCalled(); // never ran the doomed writes
		expect(res.statusCode).toBe(200); // Vercel must not count it as a hard failure
		const body = JSON.parse(res.body);
		expect(body).toMatchObject({ ok: true, skipped: 'db_at_storage_cap', size_mb: 511, high_water_mb: 470 });
		// One informative warn, not a per-row storm.
		expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('db at storage cap'))).toBe(true);
	});

	it('runs the handler normally when storage is not pressured', async () => {
		isStoragePressured.mockResolvedValue({ pressured: false, sizeMb: 120, highWaterMb: 470 });
		const handler = vi.fn(async (_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ ok: true, observed: 3 })); });
		const wrapped = wrapCron(handler, { requireWriteCapacity: true });
		const res = fakeRes();

		await wrapped(req(), res);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(JSON.parse(res.body)).toMatchObject({ ok: true, observed: 3 });
	});

	it('never probes and always runs the handler when the flag is absent', async () => {
		const handler = vi.fn(async (_req, res) => { res.statusCode = 200; res.end('{}'); });
		const wrapped = wrapCron(handler); // legacy call site — no options
		const res = fakeRes();

		await wrapped(req(), res);

		expect(isStoragePressured).not.toHaveBeenCalled();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('fails open — a probe fault must not stall the tick', async () => {
		isStoragePressured.mockRejectedValue(new Error('probe blew up'));
		const handler = vi.fn(async (_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ ok: true })); });
		const wrapped = wrapCron(handler, { requireWriteCapacity: true });
		const res = fakeRes();

		await wrapped(req(), res);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(JSON.parse(res.body)).toMatchObject({ ok: true });
	});
});
