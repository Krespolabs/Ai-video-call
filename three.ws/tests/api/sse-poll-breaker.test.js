// api/_lib/sse-poll-breaker.js — the pure breaker + backoff + dedupe-prune logic
// behind the IRL inbox SSE poller (api/irl/interactions-stream.js).
//
// Resilience (task 12, item 3 + 4): a DB outage must NOT turn the shared poll loop
// into a tight POLL_MS_MIN retry storm, and the dedupe `seen` set must stay bounded
// on a long-lived warm instance. The policy lives here, clock-injected and I/O-free,
// so we can assert it deterministically:
//   - a quota error trips the breaker at once;
//   - any other persistent error trips after N CONSECUTIVE failures (not 1 blip);
//   - while tripped the loop skips the query (isOpen), and the cooldown grows
//     exponentially per consecutive trip, capped;
//   - the first clean poll resets everything (immediate recovery);
//   - pruneSeen bounds the dedupe set without dropping ids still in the overlap.

import { describe, it, expect } from 'vitest';
import { createPollBreaker, pruneSeen, BREAKER_DEFAULTS } from '../../api/_lib/sse-poll-breaker.js';

describe('createPollBreaker — non-quota persistent failures', () => {
	it('absorbs a single blip but trips after N CONSECUTIVE failures', () => {
		const b = createPollBreaker({ failuresBeforeTrip: 3, baseCooldownMs: 60_000 });
		const t = 1_000_000;

		expect(b.onFailure(t).tripped).toBe(false);          // 1
		expect(b.isOpen(t)).toBe(false);
		expect(b.onFailure(t).tripped).toBe(false);          // 2
		expect(b.isOpen(t)).toBe(false);

		const trip = b.onFailure(t);                          // 3 → trips
		expect(trip.tripped).toBe(true);
		expect(trip.consecutiveFailures).toBe(3);
		expect(trip.cooldownMs).toBe(60_000);
		expect(b.isOpen(t)).toBe(true);
		expect(b.isOpen(t + 59_999)).toBe(true);              // still cooling
		expect(b.isOpen(t + 60_000)).toBe(false);             // window elapsed
		expect(b.cooldownUntil()).toBe(t + 60_000);
	});

	it('a success between failures resets the consecutive counter (no premature trip)', () => {
		const b = createPollBreaker({ failuresBeforeTrip: 3 });
		const t = 1_000_000;
		b.onFailure(t);
		b.onFailure(t);
		expect(b.onSuccess().recovered).toBe(true);           // counter was non-zero
		expect(b.onFailure(t).tripped).toBe(false);           // count restarted at 1
		expect(b.onFailure(t).tripped).toBe(false);           // 2
		expect(b.isOpen(t)).toBe(false);
	});
});

describe('createPollBreaker — quota error', () => {
	it('trips immediately on a quota error without waiting for the threshold', () => {
		const b = createPollBreaker({ failuresBeforeTrip: 3, baseCooldownMs: 60_000 });
		const t = 2_000_000;
		const trip = b.onFailure(t, { immediate: true });
		expect(trip.tripped).toBe(true);
		expect(trip.consecutiveFailures).toBe(1);
		expect(b.isOpen(t)).toBe(true);
	});
});

describe('createPollBreaker — exponential backoff + cap', () => {
	it('doubles the cooldown each consecutive trip, capped at maxCooldownMs', () => {
		const b = createPollBreaker({
			failuresBeforeTrip: 1,        // trip on every failure to exercise backoff
			baseCooldownMs: 1_000,
			maxCooldownMs: 4_000,
		});
		let t = 0;
		// 1st trip → base, then re-check past the window so the next failure is a new trip.
		expect(b.onFailure(t).cooldownMs).toBe(1_000);
		t += 1_000;
		expect(b.onFailure(t).cooldownMs).toBe(2_000);  // ×2
		t += 2_000;
		expect(b.onFailure(t).cooldownMs).toBe(4_000);  // ×4, hits cap
		t += 4_000;
		expect(b.onFailure(t).cooldownMs).toBe(4_000);  // capped, not 8_000
	});

	it('recovery (a clean poll) restarts the backoff at base', () => {
		const b = createPollBreaker({ failuresBeforeTrip: 1, baseCooldownMs: 1_000, maxCooldownMs: 8_000 });
		let t = 0;
		expect(b.onFailure(t).cooldownMs).toBe(1_000);
		t += 1_000;
		expect(b.onFailure(t).cooldownMs).toBe(2_000);
		// DB returns: a successful poll clears the breaker entirely.
		expect(b.onSuccess().recovered).toBe(true);
		expect(b.isOpen(t)).toBe(false);
		expect(b.failureCount()).toBe(0);
		// The next outage starts from the base cooldown again, not where backoff left off.
		expect(b.onFailure(t).cooldownMs).toBe(1_000);
	});
});

describe('createPollBreaker — reset + defaults', () => {
	it('reset() clears an open breaker (loop teardown)', () => {
		const b = createPollBreaker({ failuresBeforeTrip: 1, baseCooldownMs: 60_000 });
		const t = 5_000;
		b.onFailure(t);
		expect(b.isOpen(t)).toBe(true);
		b.reset();
		expect(b.isOpen(t)).toBe(false);
		expect(b.failureCount()).toBe(0);
		expect(b.cooldownUntil()).toBe(0);
	});

	it('onSuccess on a healthy breaker reports no recovery', () => {
		const b = createPollBreaker();
		expect(b.onSuccess().recovered).toBe(false);
	});

	it('exposes sane defaults', () => {
		expect(BREAKER_DEFAULTS.failuresBeforeTrip).toBeGreaterThanOrEqual(2);
		expect(BREAKER_DEFAULTS.baseCooldownMs).toBeGreaterThan(0);
		expect(BREAKER_DEFAULTS.maxCooldownMs).toBeGreaterThanOrEqual(BREAKER_DEFAULTS.baseCooldownMs);
	});
});

describe('pruneSeen — bounded dedupe memory (item 4)', () => {
	it('returns the same set untouched while under the cap', () => {
		const seen = new Set(['a', 'b', 'c']);
		const out = pruneSeen(seen, ['a', 'b'], 10);
		expect(out).toBe(seen);          // same reference — no allocation
		expect(out.size).toBe(3);
	});

	it('rebuilds from the current-tick ids once over the cap, dropping stale ids', () => {
		const seen = new Set(['old1', 'old2', 'old3', 'cur1', 'cur2']);
		const out = pruneSeen(seen, ['cur1', 'cur2'], 4);
		expect(out).not.toBe(seen);      // fresh set
		expect([...out].sort()).toEqual(['cur1', 'cur2']);
	});

	it('filters falsy ids out of the rebuilt set', () => {
		const seen = new Set(['x', 'y', 'z', 'w', 'v']);
		const out = pruneSeen(seen, ['keep', null, undefined, '', 'keep2'], 3);
		expect([...out].sort()).toEqual(['keep', 'keep2']);
	});

	it('handles an empty keep list (everything stale) by emptying the set', () => {
		const seen = new Set(['a', 'b', 'c', 'd', 'e']);
		const out = pruneSeen(seen, [], 2);
		expect(out.size).toBe(0);
	});

	it('passes a non-Set through unchanged (defensive)', () => {
		expect(pruneSeen(null, ['a'], 1)).toBe(null);
	});
});
