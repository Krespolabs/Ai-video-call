import { describe, it, expect } from 'vitest';

import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';
import {
	run,
	RESERVATION_LEAK_REDIS_ALERT_KEY,
	RESERVATION_LEAK_REDIS_LATEST_KEY,
	RESERVATION_LEAK_AGE_SECONDS,
} from '../api/_lib/x402/pipelines/spend-reservation-leak-detector.js';

// Captured-SQL mock: answers the two leak scans from the given rows, resolves []
// for DDL/INSERTs, and can be made to reject a matching statement (error paths).
function mockSql({ custodyRows = [], solRows = [], failOn = null } = {}) {
	const calls = [];
	const fn = (strings, ...values) => {
		const text = strings.join('?').replace(/\s+/g, ' ').trim();
		calls.push({ text, values });
		if (failOn && failOn.test(text)) return Promise.reject(new Error('mock_db_down'));
		if (/FROM agent_custody_events/i.test(text)) return Promise.resolve(custodyRows);
		if (/FROM agent_actions/i.test(text)) return Promise.resolve(solRows);
		return Promise.resolve([]);
	};
	fn.calls = calls;
	return fn;
}

function mockRedis() {
	const store = new Map();
	const ops = [];
	return {
		store, ops,
		set: async (k, v) => { ops.push(['set', k]); store.set(k, v); },
		del: async (k) => { ops.push(['del', k]); store.delete(k); },
	};
}

const noopReleasers = { releaseSpend: async () => {}, releaseSpendReservation: async () => {} };

describe('autonomous registry — spend-reservation-leak-detector entry', () => {
	const entry = getSelfRegistry().find((e) => e.id === 'spend-reservation-leak-detector');

	it('exists, enabled, finance pipeline, free, 15-min cooldown', () => {
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('finance');
		expect(entry.price_atomic).toBe(0);
		expect(entry.cooldown_s).toBe(900);
		expect(entry.cooldown_seconds).toBe(900);
		expect(typeof entry.run).toBe('function');
	});
});

describe('spend-reservation-leak-detector run()', () => {
	it('clean sweep: success, free, own log row, alert cleared', async () => {
		const sql = mockSql();
		const redis = mockRedis();
		const out = await run({ sql, redis, ...noopReleasers });

		expect(out.success).toBe(true);
		expect(out.recorded).toBe(true);
		expect(out.amountAtomic).toBe(0);
		expect(out.valueExtracted.leaked_total).toBe(0);
		expect(out.note).toBe('no leaked reservations');

		const texts = sql.calls.map((c) => c.text);
		expect(texts.some((t) => /CREATE TABLE IF NOT EXISTS spend_reservation_leaks/i.test(t))).toBe(true);
		expect(texts.some((t) => /ADD COLUMN IF NOT EXISTS value_extracted/i.test(t))).toBe(true);
		expect(texts.some((t) => /FROM agent_custody_events/i.test(t))).toBe(true);
		expect(texts.some((t) => /FROM agent_actions/i.test(t))).toBe(true);

		const logRow = sql.calls.find((c) => /INSERT INTO x402_autonomous_log/i.test(c.text));
		expect(logRow).toBeTruthy();
		expect(logRow.values).toContain('finance');
		expect(logRow.values).toContain(true); // success
		expect(redis.store.has(RESERVATION_LEAK_REDIS_LATEST_KEY)).toBe(true);
		expect(redis.ops.some((o) => o[0] === 'del' && o[1] === RESERVATION_LEAK_REDIS_ALERT_KEY)).toBe(true);
	});

	it('USD leak: releases the reservation, records evidence, raises alert', async () => {
		const custodyRows = [{
			id: 7, agent_id: 'agentUSD', asset: 'USDC', usd: 0.05, category: 'x402',
			age_seconds: 5400, created_at: new Date().toISOString(),
		}];
		const released = [];
		const sql = mockSql({ custodyRows });
		const redis = mockRedis();
		const out = await run({
			sql, redis, ...noopReleasers,
			releaseSpendReservation: async (id, reason) => { released.push([id, reason]); },
		});

		expect(out.valueExtracted.leaked_total).toBe(1);
		expect(out.valueExtracted.usd_freed).toBe(0.05);
		expect(out.valueExtracted.agents_affected).toBe(1);
		expect(released).toEqual([[7, 'leak_detector_swept']]);

		const leakInsert = sql.calls.find((c) => /INSERT INTO spend_reservation_leaks/i.test(c.text));
		expect(leakInsert).toBeTruthy();
		expect(leakInsert.values).toContain('custody_event');
		expect(leakInsert.values).toContain('released');
		expect(redis.store.has(RESERVATION_LEAK_REDIS_ALERT_KEY)).toBe(true);
	});

	it('SOL leak: records evidence BEFORE releasing (delete is destructive)', async () => {
		const solRows = [{
			id: 99, agent_id: 'agentSOL', type: 'pumpfun.buy', sol_amount: 0.25,
			mint: 'THREEsynthetic1111', age_seconds: 7200, created_at: new Date().toISOString(),
		}];
		const order = [];
		const sql = (strings, ...values) => {
			const text = strings.join('?').replace(/\s+/g, ' ').trim();
			if (/INSERT INTO spend_reservation_leaks/i.test(text)) order.push('record');
			if (/FROM agent_actions/i.test(text)) return Promise.resolve(solRows);
			if (/FROM agent_custody_events/i.test(text)) return Promise.resolve([]);
			return Promise.resolve([]);
		};
		const out = await run({
			sql, redis: mockRedis(), ...noopReleasers,
			releaseSpend: async () => { order.push('release'); },
		});

		expect(out.valueExtracted.leaked_total).toBe(1);
		expect(out.valueExtracted.sol_freed).toBe(0.25);
		// The evidence must be persisted before the row is deleted.
		expect(order).toEqual(['record', 'release']);
	});

	it('schema DDL failure: graceful error outcome, still records a log row', async () => {
		const sql = mockSql({ failOn: /CREATE TABLE IF NOT EXISTS spend_reservation_leaks/i });
		const out = await run({ sql, redis: mockRedis(), ...noopReleasers });
		expect(out.success).toBe(false);
		expect(out.recorded).toBe(true);
		expect(out.errorMsg).toMatch(/schema_failed/);
		expect(sql.calls.some((c) => /INSERT INTO x402_autonomous_log/i.test(c.text))).toBe(true);
	});

	it('a failing scan never crashes the tick', async () => {
		const sql = mockSql({ failOn: /FROM agent_custody_events/i });
		const out = await run({ sql, redis: mockRedis(), ...noopReleasers });
		expect(out.success).toBe(true);
		expect(out.valueExtracted.scanned.custody_pending).toBe(0);
	});

	it('exposes stable constants', () => {
		expect(RESERVATION_LEAK_AGE_SECONDS).toBe(3600);
		expect(RESERVATION_LEAK_REDIS_ALERT_KEY).toBe('x402:reservation-leak:alert');
	});
});
