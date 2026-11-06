// api/irl/pins.js — sweep anomaly detection (H7).
//
// The public nearby read is the only surface that reveals another agent's location.
// A scraper can stay under the per-minute rate limit by reading slowly, but a sweep
// is shaped differently from a real user: a real user polls ~1 geocell over and over
// (they stand in one place), a harvester reads MANY distinct cells. recordCellRead()
// tracks the distinct cells one caller reads in a short window and fires ONE deduped,
// COORDINATE-FREE ops alert past the threshold. These tests pin that down:
//   - distinct cells accumulate per (hashed) IP; repeats don't double-count
//   - crossing the threshold fires exactly one alert (latched per window)
//   - the alert carries NO coordinate and NO raw IP — only a hash + a count
// cache / alerts are mocked so the suite stays offline; db / auth / limiter are
// stubbed only so importing pins.js doesn't reach real infra.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory cache stand-in so distinct-cell state persists across calls in a test.
const store = new Map();
vi.mock('../../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async (k) => (store.has(k) ? store.get(k) : null)),
	cacheSet: vi.fn(async (k, v) => { store.set(k, v); }),
}));

const alertSpy = vi.fn(async () => {});
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: (...a) => alertSpy(...a) }));

// Minimal stubs so importing the handler module doesn't touch real infra.
vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(async () => []), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => null) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const { recordCellRead } = await import('../../api/irl/pins.js');

const THRESHOLD = 12; // mirrors SWEEP_CELL_THRESHOLD in pins.js
const cell = (i) => `u4pruyd${i}`.slice(0, 7) + i; // distinct geocell-shaped strings

beforeEach(() => {
	store.clear();
	alertSpy.mockClear();
});

describe('recordCellRead — sweep anomaly detection', () => {
	it('does not alert for a real user polling ONE cell repeatedly', async () => {
		for (let i = 0; i < 30; i++) await recordCellRead('1.2.3.4', 'u4pruyd');
		expect(alertSpy).not.toHaveBeenCalled();
	});

	it('does not alert below the distinct-cell threshold', async () => {
		for (let i = 0; i < THRESHOLD - 1; i++) await recordCellRead('1.2.3.4', cell(i));
		expect(alertSpy).not.toHaveBeenCalled();
	});

	it('fires exactly ONE deduped alert once distinct cells cross the threshold', async () => {
		for (let i = 0; i < THRESHOLD + 8; i++) await recordCellRead('1.2.3.4', cell(i));
		// Latched per window: one alert, not one-per-cell after the threshold.
		expect(alertSpy).toHaveBeenCalledTimes(1);
		const [title, detail, opts] = alertSpy.mock.calls[0];
		expect(title).toBe('IRL sweep suspected');
		// Deduped by the IP hash so a sustained sweep is one alert per window.
		expect(opts.signature).toMatch(/^irl-sweep:[0-9a-f]{16}$/);
	});

	it('the alert is COORDINATE-FREE and never carries the raw IP', async () => {
		const rawIp = '203.0.113.55';
		for (let i = 0; i < THRESHOLD; i++) await recordCellRead(rawIp, cell(i));
		expect(alertSpy).toHaveBeenCalledTimes(1);
		const [, detail, opts] = alertSpy.mock.calls[0];
		const blob = `${detail}\n${opts.signature}`;
		// Never the raw IP, never a geocell value, never a lat/lng.
		expect(blob).not.toContain(rawIp);
		expect(blob).not.toContain(cell(0));
		expect(blob).not.toMatch(/-?\d{1,3}\.\d{3,}/); // no decimal coordinate
		// Carries the count + a 16-hex IP hash only.
		expect(detail).toMatch(/\d+\+ distinct geocells/);
		expect(detail).toMatch(/ip_hash [0-9a-f]{16}/);
	});

	it('scopes distinct-cell counting per caller — two IPs each under the threshold do not alert', async () => {
		for (let i = 0; i < THRESHOLD - 2; i++) {
			await recordCellRead('10.0.0.1', cell(i));
			await recordCellRead('10.0.0.2', cell(i + 100));
		}
		expect(alertSpy).not.toHaveBeenCalled();
	});

	it('no-ops on a missing ip or cell (never throws)', async () => {
		await expect(recordCellRead(null, 'u4pruyd')).resolves.toBeUndefined();
		await expect(recordCellRead('1.2.3.4', null)).resolves.toBeUndefined();
		expect(alertSpy).not.toHaveBeenCalled();
	});
});
