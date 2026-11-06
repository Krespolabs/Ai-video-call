// agent-mm — publish a live market-maker event to the agent screen transport.
//
// Writes the SAME Redis keys api/agent-screen-push.js writes (frame + activity
// log + the active-agent set) so live viewers — the arena floor line, the
// /agents-live card badge — update the instant a sweep decides, without waiting
// on the DB activity poll. As a first-party worker we write Redis directly rather
// than HTTP-posting to ourselves: no self-auth, no base URL, no extra failure
// mode, and the identical frame/log schema the SSE stream already emits.
//
// The render layer is describe-only. This module never signs or moves funds — it
// publishes what engine.js already decided, normalized through mm-render.js.

import { getRedis } from '../../api/_lib/redis.js';

const FRAME_TTL = 90; // seconds — mirrors agent-screen-push (stream goes dark if we stop)
const LOG_CAP = 50;   // activity entries kept per agent

/**
 * Publish one MM event for an agent. `fired` flags a real fill (defend / recycle
 * / graduate): it earns a permanent activity-log entry; a bare quote update only
 * refreshes the live frame so the floor marker tracks price without flooding the
 * log. The `mm` ride-along carries the structured context the arena reads.
 * Best-effort: a Redis blip never aborts the sweep.
 */
export async function publishMmFrame(agentId, { actionType, summary, context, fired = false }) {
	const r = getRedis();
	if (!r || !agentId) return false;

	const now = Date.now();
	const frameKey = `agent:screen:${agentId}:frame`;
	const logKey = `agent:screen:${agentId}:log`;
	const mm = { type: actionType, ...context };

	// Text-only frame (data:null) — the card falls back to its activity terminal
	// and reads the floor state off `mm`; the arena drives the 3D floor line off it.
	const frame = JSON.stringify({ ts: now, data: null, activity: summary, type: 'trade', agentId, mm });

	const ops = [
		r.set(frameKey, frame, { ex: FRAME_TTL }),
		r.zadd('agent:screen:active', { score: now, member: agentId }),
		r.zremrangebyscore('agent:screen:active', 0, now - 120_000),
		r.expire('agent:screen:active', FRAME_TTL * 3),
	];
	if (fired) {
		const logEntry = JSON.stringify({ ts: now, activity: summary, type: actionType, mm });
		ops.push(r.lpush(logKey, logEntry).then(() => r.ltrim(logKey, 0, LOG_CAP - 1)));
		ops.push(r.expire(logKey, FRAME_TTL * 5));
	}

	try { await Promise.all(ops); return true; }
	catch { return false; }
}
