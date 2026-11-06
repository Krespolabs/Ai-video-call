/**
 * Spectator presence for live trade rooms.
 *
 * A spectator is an open room stream: /api/sniper/room-stream touches the
 * viewer's session while the connection is up and removes it on close, so the
 * number a room shows is "people with this room open right now", not a guess.
 *
 * Storage: one Redis sorted set per room (`traderoom:spec:<agentId>`), member =
 * session id, score = the instant that session expires. A viewer whose tab dies
 * without a clean close simply ages out after SPECTATOR_TTL_MS. Redis makes the
 * count true across every Cloud Run instance (scope "shared").
 *
 * Failsafe: when Upstash is not configured or a command fails, presence falls
 * back to an in-process map (scope "instance"). The room keeps a real, if
 * partial, count instead of going dark; the scope rides along so the client can
 * say which one it is showing.
 */

import { getRedis } from './redis.js';

export const SPECTATOR_TTL_MS = 30_000;
const KEY_PREFIX = 'traderoom:spec:';
const KEY_EXPIRE_SEC = 120;
/** Hard ceiling on in-process sessions so untrusted ids cannot grow the heap. */
const LOCAL_MAX_SESSIONS = 5_000;

/** @type {Map<string, Map<string, number>>} agentId -> (session -> expiresAt) */
const local = new Map();

function key(agentId) {
	return KEY_PREFIX + agentId;
}

function localPrune(now) {
	for (const [agentId, sessions] of local) {
		for (const [session, exp] of sessions) if (exp <= now) sessions.delete(session);
		if (!sessions.size) local.delete(agentId);
	}
}

function localSize() {
	let n = 0;
	for (const s of local.values()) n += s.size;
	return n;
}

function localTouch(agentId, session, now) {
	localPrune(now);
	let sessions = local.get(agentId);
	if (!sessions?.has(session) && localSize() >= LOCAL_MAX_SESSIONS) return;
	if (!sessions) {
		sessions = new Map();
		local.set(agentId, sessions);
	}
	sessions.set(session, now + SPECTATOR_TTL_MS);
}

function localCount(agentId, now) {
	localPrune(now);
	return local.get(agentId)?.size || 0;
}

/**
 * Mark a session as watching a room (call on connect and every ~10s).
 * @returns {Promise<'shared'|'instance'>} where the mark landed
 */
export async function touchSpectator(agentId, session, now = Date.now()) {
	const r = getRedis();
	if (r) {
		try {
			await Promise.all([
				r.zadd(key(agentId), { score: now + SPECTATOR_TTL_MS, member: session }),
				r.expire(key(agentId), KEY_EXPIRE_SEC),
			]);
			return 'shared';
		} catch {
			/* fall through to the in-process count */
		}
	}
	localTouch(agentId, session, now);
	return 'instance';
}

/** Remove a session from a room (call when its stream closes). Never throws. */
export async function leaveSpectator(agentId, session) {
	local.get(agentId)?.delete(session);
	const r = getRedis();
	if (!r) return;
	try {
		await r.zrem(key(agentId), session);
	} catch {
		/* the member ages out on its own after SPECTATOR_TTL_MS */
	}
}

/**
 * Live spectators in one room.
 * @returns {Promise<{count: number, scope: 'shared'|'instance'}>}
 */
export async function countSpectators(agentId, now = Date.now()) {
	const r = getRedis();
	if (r) {
		try {
			const n = await r.zcount(key(agentId), now, '+inf');
			return { count: Number(n) || 0, scope: 'shared' };
		} catch {
			/* fall through */
		}
	}
	return { count: localCount(agentId, now), scope: 'instance' };
}

/**
 * Live spectators for many rooms at once (the lobby).
 * @param {string[]} agentIds
 * @returns {Promise<Map<string, number>>}
 */
export async function countSpectatorsMany(agentIds, now = Date.now()) {
	const ids = [...new Set((agentIds || []).filter(Boolean))];
	const out = new Map();
	if (!ids.length) return out;
	const r = getRedis();
	if (r) {
		try {
			const counts = await Promise.all(ids.map((id) => r.zcount(key(id), now, '+inf')));
			ids.forEach((id, i) => out.set(id, Number(counts[i]) || 0));
			return out;
		} catch {
			out.clear();
		}
	}
	for (const id of ids) out.set(id, localCount(id, now));
	return out;
}

/** Test hook: forget every in-process session. */
export function _resetLocalPresence() {
	local.clear();
}
