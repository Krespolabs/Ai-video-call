// Pure breaker + backoff state machine for the shared SSE poll loop.
//
// The IRL inbox stream (api/irl/interactions-stream.js) tails Postgres on a warm
// instance and fans new rows to every open connection. When the DB degrades — a
// quota trip, "too many connections", a transient 5xx, or a full outage — a naive
// loop keeps re-issuing the same query at POLL_MS_MIN, turning one outage into a
// tight retry storm that saturates Vercel concurrency and the DB's connection pool.
//
// This module is the discipline that prevents that. It is PURE: no timers, no I/O,
// no Date.now() of its own — the caller drives it with onSuccess()/onFailure(now)
// and reads isOpen(now)/cooldownUntil() to schedule the next tick. That keeps the
// policy (when to trip, how long to back off, how to recover) unit-testable in
// isolation from the socket/DB plumbing it governs.
//
// Policy, mirroring the provider-health breaker (api/_lib/provider-health.js):
//   - A QUOTA error (immediate=true) trips at once — the upstream is explicitly
//     telling us to back off, so there's no point burning N more attempts.
//   - Any OTHER persistent error trips after `failuresBeforeTrip` CONSECUTIVE
//     failures, so a single blip doesn't degrade a healthy stream, but a sustained
//     DB outage does — the gap the original quota-only breaker left open.
//   - While tripped the caller polls nothing (heartbeat-only); the cooldown grows
//     exponentially per consecutive trip, capped, so a long outage isn't probed
//     every minute forever.
//   - The FIRST clean poll resets everything: failure count, open window, and the
//     backoff step — so recovery is immediate and the next outage starts fresh.

export const BREAKER_DEFAULTS = {
	failuresBeforeTrip: 3,         // consecutive non-quota failures before degrading
	baseCooldownMs: 60_000,        // cooldown on the first trip
	maxCooldownMs: 5 * 60_000,     // exponential-backoff ceiling
};

// Bound the SSE dedupe set. `seen` holds ids already dispatched so the re-query
// overlap window can't double-deliver a row. It only ever needs ids still inside
// that overlap — once the watermark advances past a row it can never be re-queried,
// so older ids are dead weight. When the set exceeds `max`, rebuild it from just
// the ids still in play (the current tick's rows); dropping the rest can never
// cause a re-dispatch. Returns the same Set when under the cap (no allocation),
// or a fresh, pruned Set when over it. Pure — no I/O, easy to assert.
export function pruneSeen(seen, keepIds, max) {
	if (!(seen instanceof Set) || seen.size <= max) return seen;
	const next = new Set();
	for (const id of keepIds || []) {
		if (id) next.add(id);
	}
	return next;
}

// Create a breaker instance. `opts` overrides BREAKER_DEFAULTS (tests inject tiny
// cooldowns; the stream uses the defaults). All time is passed in by the caller —
// the breaker never reads the clock itself, so its behaviour is fully deterministic.
export function createPollBreaker(opts = {}) {
	const cfg = { ...BREAKER_DEFAULTS, ...opts };
	let consecutiveFailures = 0;  // reset by any success
	let openUntil = 0;            // epoch-ms; > now ⇒ tripped (skip the query)
	let backoffStep = 0;          // # of trips since the last recovery; drives the exponent

	return {
		// A clean poll — the DB is healthy. Clear the failure count, close the
		// breaker, and reset the backoff so the next outage starts from baseCooldown.
		onSuccess() {
			const wasOpen = openUntil !== 0 || consecutiveFailures !== 0;
			consecutiveFailures = 0;
			openUntil = 0;
			backoffStep = 0;
			return { recovered: wasOpen };
		},

		// A failed poll at `now` (epoch-ms). Pass immediate=true for a quota error to
		// trip without waiting for the consecutive-failure threshold. Returns whether
		// the breaker is now tripped and, if so, the cooldown applied.
		onFailure(now, { immediate = false } = {}) {
			consecutiveFailures += 1;
			const shouldTrip = immediate || consecutiveFailures >= cfg.failuresBeforeTrip;
			if (!shouldTrip) {
				return { tripped: false, cooldownMs: 0, cooldownUntil: 0, consecutiveFailures };
			}
			const cooldownMs = Math.min(cfg.maxCooldownMs, cfg.baseCooldownMs * 2 ** backoffStep);
			openUntil = now + cooldownMs;
			backoffStep += 1;
			return { tripped: true, cooldownMs, cooldownUntil: openUntil, consecutiveFailures };
		},

		// Is the breaker currently tripped at `now`? True ⇒ skip the DB query this tick.
		isOpen(now) { return openUntil > now; },

		// When the current cooldown expires (epoch-ms; 0 when never tripped). The
		// caller schedules its next wake-up here instead of at the hot POLL_MS_MIN.
		cooldownUntil() { return openUntil; },

		// Diagnostics for the caller's one-shot degrade log.
		failureCount() { return consecutiveFailures; },

		// Hard reset — used when the loop is torn down (all connections gone).
		reset() {
			consecutiveFailures = 0;
			openUntil = 0;
			backoffStep = 0;
		},
	};
}
