// In-process screen-frame publisher for first-party API flows.
//
// /api/agent-screen-push is the HTTP path external casters use. Some flows run
// INSIDE the API (the a2a-hire orchestrator) and publish a frame without a
// round-trip to themselves. This writes the SAME Redis records the push endpoint
// does — latest-frame key (TTL'd so the stream goes dark if the source stops), a
// capped activity-log list, and the active-agents sorted set the 3D walk scene
// reads — and adds the two things a server-internal narration frame needs:
//
//   • A bounded structured `meta` sidecar (the hire visualizer's phase payload).
//   • Image preservation: a text/meta-only frame must NOT blank the agent's last
//     screenshot, so we carry the previous frame's image forward.

import { getRedis } from './redis.js';

const FRAME_TTL = 90; // seconds — mirrors agent-screen-push.js
const LOG_CAP = 50;
const ACTIVITY_MAX = 320;
const FRAME_TYPES = ['screenshot', 'activity', 'trade', 'analysis'];

// Bound the meta sidecar so a caller can't push an unbounded blob into Redis.
function safeMeta(meta) {
	if (!meta || typeof meta !== 'object') return null;
	try {
		const s = JSON.stringify(meta);
		if (s.length > 4000) return null;
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// Publish a frame for `agentId`. Fire-and-forget by contract: returns true when
// written, false when Redis is down or the input is unusable, and NEVER throws —
// callers must never let a frame write block or fail real work (e.g. settlement).
export async function writeScreenFrame(agentId, frame = {}, { nowMs, preserveImage = true } = {}) {
	try {
		const r = getRedis();
		if (!r || !agentId || typeof agentId !== 'string') return false;

		const now = nowMs || Date.now();
		const activity = String(frame.activity || '').slice(0, ACTIVITY_MAX);
		const type = FRAME_TYPES.includes(frame.type) ? frame.type : 'activity';
		const meta = safeMeta(frame.meta);

		const frameKey = `agent:screen:${agentId}:frame`;
		const logKey = `agent:screen:${agentId}:log`;

		// Preserve the agent's last screenshot when this frame carries no image, so a
		// text/meta narration never blanks a live caster's screen.
		let data = typeof frame.data === 'string' ? frame.data : null;
		if (!data && preserveImage) {
			try {
				const prevRaw = await r.get(frameKey);
				const prev = prevRaw ? (typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw) : null;
				if (prev?.data) data = prev.data;
			} catch {
				/* no prior frame — publish image-less */
			}
		}

		const frameRecord = JSON.stringify({ ts: now, data, activity, type, agentId, ...(meta ? { meta } : {}) });
		const logEntry = JSON.stringify({ ts: now, activity, type, ...(meta ? { meta } : {}) });

		await Promise.all([
			r.set(frameKey, frameRecord, { ex: FRAME_TTL }),
			r.lpush(logKey, logEntry).then(() => r.ltrim(logKey, 0, LOG_CAP - 1)),
			r.expire(logKey, FRAME_TTL * 5),
			r.zadd('agent:screen:active', { score: now, member: agentId }),
			r.zremrangebyscore('agent:screen:active', 0, now - 120_000),
			r.expire('agent:screen:active', FRAME_TTL * 3),
		]);
		return true;
	} catch {
		return false;
	}
}
