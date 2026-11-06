// GET /api/irl/interactions-stream — Server-Sent Events for the owner's IRL inbox.
//
// This is the realtime delivery layer for D3 (`A → server → owner`). The C4
// dashboard (src/dashboard-next/pages/irl-placements.js) does one fast GET
// /api/irl/interactions?mine=1 for first paint, then opens THIS stream so a tap,
// message, or pay on a placed agent lands in the open inbox within ~1s instead of
// only on the next reload — even though the owner is almost never standing in the
// same geocell as the passer-by.
//
// The geocell room (D1/D2) broadcasts the co-located *ambient reaction*; the
// owner is reached here instead, off the authoritative interaction log, so the
// owner channel never depends on the WS host being up. The interaction RECORD
// always flows through POST /api/irl/interactions (C4) → irl_interactions; this
// stream only tails that table for the connected owner and pushes new rows.
//
// ── Why poll Postgres instead of pub/sub ─────────────────────────────────────
// Vercel can't hold a WebSocket and the Upstash REST client this repo uses has no
// long-lived SUBSCRIBE, so — exactly like api/feed-stream.js — we tail the source
// with a cheap, bounded query and fan the result to every connection on the warm
// instance. The interaction table is low-volume per owner (a dashboard, not a
// firehose), so a single indexed `created_at` range scan per tick is trivial.
//
// ── Quota / load discipline ──────────────────────────────────────────────────
// Vercel runs each SSE connection in its own invocation, but concurrent
// connections frequently share a warm instance. A naive per-connection loop would
// multiply DB reads by the open-tab count, so all connections on an instance share
// ONE poll loop: each tick issues a single query for the union of connected
// owners and dispatches each row to the matching owner's connection(s). The
// cadence is adaptive — fast right after activity, ramping toward POLL_MS_MAX while
// the inbox is idle (which it mostly is) — and a quota/error breaker degrades to
// heartbeats so a dead DB never turns into a poll storm.
//
// Vercel: registered with maxDuration 300 in vercel.json; we send a `retry`
// directive and close just before the hard timeout, and EventSource reconnects.

import { cors, method } from '../_lib/http.js';
import { getSessionUser } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { databaseConfigured } from '../_lib/env.js';
import { readDeviceToken } from '../_lib/irl-auth.js';
import { createPollBreaker, pruneSeen } from '../_lib/sse-poll-breaker.js';

const HEARTBEAT_MS = 15_000;
const POLL_MS_MIN = 2_000;   // fast cadence right after activity
const POLL_MS_MAX = 15_000;  // idle ceiling — the inbox is idle most of the time
const IDLE_TICKS_BEFORE_RAMP = 3;
const OVERLAP_MS = 2_000;    // re-scan window so a row committed mid-tick isn't skipped
const ROW_LIMIT = 200;       // per-tick cap; deduped by id across the overlap
const SEEN_MAX = 1_000;      // bound the dedupe set on a long-lived instance
// Trip the poll breaker after this many CONSECUTIVE failures of ANY kind (a quota
// error trips immediately). Below this a single blip is absorbed; at or above it a
// sustained DB outage degrades to heartbeat-only with exponential backoff (the
// gap the old quota-only breaker left — a DB outage became a POLL_MS_MIN storm).
const BREAKER_FAILS_BEFORE_TRIP = 3;
const BREAKER_BASE_COOLDOWN_MS = 60_000;
const MAX_DURATION_MS = 275_000; // close before Vercel's 300s hard timeout
const METRICS_INTERVAL_MS = 60_000; // emit at most one poller-health line this often

// Only the fields the owner is allowed to see leave the server. NEVER the actor's
// identity (viewer_user_id/viewer_device) or any actor GPS — the lat/lng below are
// the OWNER's own pin location, which they already know. For a `pay`, the payload
// is reduced to the settlement signature + network so the inbox can deep-link the
// receipt; everything else in payload is dropped. Mirrors the GET ?mine=1 row
// shape so the client renders a live row identically to a polled one.
export function publicRow(r) {
	const payload = {};
	if (r.type === 'pay' && r.payload && typeof r.payload === 'object') {
		if (r.payload.signature) payload.signature = String(r.payload.signature);
		if (r.payload.network) payload.network = String(r.payload.network);
	}
	return {
		id: r.id,
		pin_id: r.pin_id,
		agent_id: r.agent_id,
		type: r.type,
		message: r.message,
		amount: r.amount,
		currency_mint: r.currency_mint,
		avatar_name: r.avatar_name,
		caption: r.caption,
		lat: r.lat,
		lng: r.lng,
		payload,
		created_at: r.created_at,
	};
}

function isQuotaError(err) {
	const m = (err && (err.message || String(err))) || '';
	return /too many connections|rate limit|quota|429|max requests/i.test(m);
}

// ── Per-instance shared poller ───────────────────────────────────────────────
// Every connection on this warm Lambda registers here; one loop fans fresh rows
// to all of them. A connection only ever receives rows created AFTER it joined
// (connectedAt) for an owner identity it actually owns (server-derived auth).
const connections = new Set();
let pollTimer = null;
let polling = false;
let lastPollAt = 0;          // ms; watermark floor for the next query
let seen = new Set();        // recently-dispatched ids — global dedupe across overlap
let currentDelay = POLL_MS_MIN;
let idleTicks = 0;
// Breaker + exponential backoff for the DB poll. Trips on a quota error at once or
// after BREAKER_FAILS_BEFORE_TRIP consecutive failures of any kind; the first clean
// poll resets it. Pure state machine — see api/_lib/sse-poll-breaker.js.
const breaker = createPollBreaker({
	failuresBeforeTrip: BREAKER_FAILS_BEFORE_TRIP,
	baseCooldownMs: BREAKER_BASE_COOLDOWN_MS,
});
let breakerLogged = false;   // dedupe the degrade log to one line per outage

// ── Poller health telemetry (task 14) ────────────────────────────────────────
// Rolling per-window counters so a stuck or thrashing poller is diagnosable from
// the logs without a metrics backend. Reset each time a health line is emitted.
// All aggregate counts — no actor identity, no coordinates ever enter these.
let metricsWindowStart = 0;
let dispatchedInWindow = 0;
let sendErrorsInWindow = 0;
let pollErrorsInWindow = 0;
let pollsInWindow = 0;

// Emit one structured health line once per METRICS_INTERVAL_MS while connections
// are live: open connections, dispatch rate, error counts, and the current poll
// delay (so a poller pinned at POLL_MS_MAX or stuck behind the breaker is visible).
function emitPollerMetrics(now) {
	if (!metricsWindowStart) { metricsWindowStart = now; return; }
	if (now - metricsWindowStart < METRICS_INTERVAL_MS) return;
	const windowMs = now - metricsWindowStart;
	console.log('[irl-stream] poller health', {
		connections: connections.size,
		polls: pollsInWindow,
		dispatched: dispatchedInWindow,
		dispatchRatePerMin: Math.round((dispatchedInWindow / windowMs) * 60_000),
		pollErrors: pollErrorsInWindow,
		sendErrors: sendErrorsInWindow,
		currentDelayMs: currentDelay,
		breakerOpen: breaker.isOpen(now),
		windowMs,
	});
	metricsWindowStart = now;
	dispatchedInWindow = 0;
	sendErrorsInWindow = 0;
	pollErrorsInWindow = 0;
	pollsInWindow = 0;
}

function resetSharedState() {
	if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
	polling = false;
	lastPollAt = 0;
	seen = new Set();
	currentDelay = POLL_MS_MIN;
	idleTicks = 0;
	breaker.reset();
	breakerLogged = false;
	metricsWindowStart = 0;
	dispatchedInWindow = 0;
	sendErrorsInWindow = 0;
	pollErrorsInWindow = 0;
	pollsInWindow = 0;
}

function scheduleNextPoll(delayMs) {
	if (pollTimer) clearTimeout(pollTimer);
	if (connections.size === 0) { pollTimer = null; return; }
	let delay = delayMs;
	if (delay == null) {
		const now = Date.now();
		// While the breaker is tripped, wake at the cooldown expiry — not the hot
		// POLL_MS_MIN — so a DB outage degrades to heartbeat-only instead of a
		// tight retry loop. Otherwise use the adaptive cadence.
		delay = breaker.isOpen(now)
			? Math.max(POLL_MS_MIN, breaker.cooldownUntil() - now)
			: currentDelay;
	}
	pollTimer = setTimeout(runPoll, delay);
}

export function matches(conn, row) {
	return (conn.ownerId && row.owner_id === conn.ownerId)
		|| (conn.ownerDev && row.owner_dev === conn.ownerDev);
}

async function runPoll() {
	pollTimer = null;
	if (connections.size === 0) return;
	if (polling) { scheduleNextPoll(); return; }

	const now = Date.now();
	// Breaker tripped (quota or a sustained DB outage): skip the query entirely so the
	// loop is heartbeat-only, and re-check after the backoff window rather than at the
	// hot cadence. scheduleNextPoll() reads the breaker and waits out the cooldown.
	if (breaker.isOpen(now)) { scheduleNextPoll(); return; }

	// Distinct owner identities currently connected — one query covers them all.
	const ownerIds = [...new Set([...connections].map((c) => c.ownerId).filter(Boolean))];
	const ownerDevs = [...new Set([...connections].map((c) => c.ownerDev).filter(Boolean))];
	if (!ownerIds.length && !ownerDevs.length) { scheduleNextPoll(); return; }

	polling = true;
	pollsInWindow++;
	if (!metricsWindowStart) metricsWindowStart = now;
	const pollStart = now;
	const watermark = new Date(lastPollAt - OVERLAP_MS).toISOString();
	try {
		const rows = await sql`
			SELECT ix.id, ix.pin_id, ix.agent_id, ix.type, ix.message,
			       ix.amount, ix.currency_mint, ix.payload, ix.created_at,
			       p.user_id AS owner_id, p.device_token AS owner_dev,
			       p.avatar_name, p.caption, ix.lat, ix.lng
			FROM irl_interactions ix
			JOIN irl_pins p ON p.id = ix.pin_id
			WHERE ix.created_at >= ${watermark}
			  AND ( p.user_id = ANY(${ownerIds}::uuid[])
			     OR p.device_token = ANY(${ownerDevs}::text[]) )
			ORDER BY ix.created_at ASC
			LIMIT ${ROW_LIMIT}
		`;
		// A successful read clears the breaker — failure count, open window, and the
		// backoff step all reset, so recovery is immediate and the next outage starts
		// from the base cooldown again.
		breaker.onSuccess();
		breakerLogged = false;

		let dispatched = 0;
		for (const row of rows || []) {
			if (!row.id || seen.has(row.id)) continue;
			seen.add(row.id);
			const createdMs = new Date(row.created_at).getTime();
			const safe = publicRow(row);
			for (const conn of connections) {
				// Only the owner, and only events that happened after they connected
				// (so a fresh tab is never spammed with the pre-connect backlog).
				if (createdMs <= conn.connectedAt) continue;
				if (!matches(conn, row)) continue;
				// A throw here is a dead socket mid-teardown; its own close handler
				// unregisters it, so per-frame logging would be noise. Count it instead
				// and surface the aggregate in the periodic health line (a high sendErrors
				// rate flags clients the poller can't reach).
				try { conn.send('interaction', safe); dispatched++; } catch { sendErrorsInWindow++; }
			}
		}

		if (dispatched > 0) {
			currentDelay = POLL_MS_MIN; // activity → speed back up
			idleTicks = 0;
		} else if (++idleTicks >= IDLE_TICKS_BEFORE_RAMP) {
			currentDelay = Math.min(POLL_MS_MAX, currentDelay * 2);
		}

		// Advance the watermark to this poll's start so the next tick covers exactly
		// [pollStart - overlap, nextPoll], no gaps; the overlap + `seen` cover the
		// boundary. Bound the dedupe set on a long-lived instance.
		lastPollAt = pollStart;
		seen = pruneSeen(seen, (rows || []).map((r) => r.id), SEEN_MAX);
		dispatchedInWindow += dispatched;
	} catch (err) {
		pollErrorsInWindow++;
		// Trip the breaker on a quota error immediately, or after N consecutive failures
		// of ANY kind — so a sustained DB outage (not only a quota trip) degrades to
		// heartbeat-only with exponential backoff instead of a tight POLL_MS_MIN retry
		// loop. The first clean poll above resets it (immediate recovery).
		const trip = breaker.onFailure(Date.now(), { immediate: isQuotaError(err) });
		if (trip.tripped) {
			if (!breakerLogged) {
				console.error(
					`[irl-stream] DB poll degraded after ${trip.consecutiveFailures} failure(s) — ` +
						`heartbeat-only for ${Math.round(trip.cooldownMs / 1000)}s:`,
					err?.message || err,
				);
				breakerLogged = true;
			}
		} else {
			console.error('[irl-stream] poll failed (transient)', err?.message || err);
		}
	} finally {
		polling = false;
		emitPollerMetrics(Date.now());
		scheduleNextPoll();
	}
}

function addConnection(conn) {
	if (connections.size === 0) lastPollAt = Date.now(); // first connection arms the loop
	connections.add(conn);
	if (!pollTimer && !polling) {
		currentDelay = POLL_MS_MIN; // a new subscriber wants prompt updates
		idleTicks = 0;
		scheduleNextPoll();
	}
}

function removeConnection(conn) {
	connections.delete(conn);
	if (connections.size === 0) resetSharedState();
}

export default async function handleIrlInteractionsStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	// Owner identity is server-derived, never trusted from a body. Signed-in owners
	// match by session; anonymous placements match by their device token (the same
	// dual identity the GET ?mine=1 inbox + PATCH mark-read use).
	const session = await getSessionUser(req, res).catch(() => null);
	const ownerId = session?.id ?? null;
	// H2 transport: prefer the x-irl-device header (used by fetch-based EventSource
	// shims). Native browser EventSource CANNOT set request headers, so this stream
	// retains the `?deviceToken=` query fallback for it — accepted here as a
	// deliberate, documented exception. The token in that URL is scrubbed from every
	// log sink by redactUrl() (api/_lib/http.js); the response is no-store; and the
	// stream only ever returns the OWNER's own inbox, never another user's location.
	const ownerDev = readDeviceToken(req);
	if (!ownerId && !ownerDev) {
		res.statusCode = 401;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ error: 'sign in or pass deviceToken' }));
		return;
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'Connection': 'keep-alive',
		// Vercel's edge gateway buffers responses by default; without this it holds
		// SSE frames until the function returns, defeating the stream.
		'X-Accel-Buffering': 'no',
	});

	let closed = false;
	const send = (event, data) => {
		if (closed || res.writableEnded) return;
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	send('hello', { ts: Date.now() });

	// No DB configured (e.g. local dev without DATABASE_URL): keep the socket alive
	// with heartbeats so the client's fallback poll path still runs, emit nothing.
	if (!databaseConfigured()) {
		const hb = setInterval(() => {
			if (closed || res.writableEnded) { clearInterval(hb); return; }
			res.write(':hb\n\n');
		}, HEARTBEAT_MS);
		const stop = () => { closed = true; clearInterval(hb); try { res.end(); } catch {} };
		req.on('close', stop); res.on('close', stop); req.on('error', stop);
		return;
	}

	const conn = { ownerId, ownerDev, connectedAt: Date.now(), send };
	addConnection(conn);

	const startMs = Date.now();
	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		if (Date.now() - startMs > MAX_DURATION_MS) {
			res.write('retry: 1000\n\n'); // EventSource reconnects after ~1s
			cleanup();
			return;
		}
		res.write(':hb\n\n');
	}, HEARTBEAT_MS);

	function cleanup() {
		if (closed) return;
		closed = true;
		removeConnection(conn);
		clearInterval(heartbeat);
		if (!res.writableEnded) { try { res.end(); } catch { /* torn down */ } }
	}

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('close', cleanup);
	res.on('error', cleanup);
}
