// The shared memory client. Every Living-Agents surface that reads or mutates an
// agent's memory goes through here instead of hand-rolling fetch logic, so:
//   • there is one place that knows the real /api/agent-memory contract, and
//   • every successful mutation emits the matching bus event, which is what makes
//     a memory added in a marketplace chat ripple to the Mind Palace and the HUD
//     in real time.
//
// Tasks 03 (Mind Palace), 04 (Dreams), 07 (Emotion) and 08 (Autopilot) mutate
// memory exclusively through this module.

import { apiFetch } from '../api.js';
import { agentBus } from './agent-bus.js';

/** ISO timestamp for a bus event, derived from the server's ms epoch when present. */
function isoFrom(ms) {
	return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

async function readJson(res) {
	return res.json().catch(() => ({}));
}

/**
 * List an agent's memories. Owner-only on the server: a non-owner (or anonymous)
 * caller receives an empty list rather than an error, so this is safe to call on
 * any surface.
 *
 * @param {string} agentId
 * @param {Object} [opts]
 * @param {('user'|'feedback'|'project'|'reference')} [opts.type] - filter by type
 * @param {number} [opts.since] - only entries created after this epoch-ms
 * @param {number} [opts.limit=200] - 1..500
 * @returns {Promise<Array<Object>>} decorated memory records (newest first)
 */
export async function listMemories(agentId, opts = {}) {
	if (!agentId) return [];
	const params = new URLSearchParams({ agentId });
	if (opts.type) params.set('type', opts.type);
	if (Number.isFinite(opts.since)) params.set('since', String(opts.since));
	if (Number.isFinite(opts.limit)) params.set('limit', String(opts.limit));
	const res = await apiFetch(`/api/agent-memory?${params.toString()}`, {
		credentials: 'include',
		allowAnonymous: true,
	});
	if (!res.ok) throw new Error(`listMemories failed: ${res.status}`);
	const j = await readJson(res);
	return Array.isArray(j.entries) ? j.entries : [];
}

// One upsert path on the server; the client distinguishes create vs update by
// whether the entry already carries an id, and emits the right bus event.
async function upsert(agentId, entry) {
	const res = await apiFetch('/api/agent-memory', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ agentId, entry }),
	});
	if (!res.ok) {
		const j = await readJson(res);
		throw new Error(j.error || `memory write failed: ${res.status}`);
	}
	const j = await readJson(res);
	return j.entry || null;
}

/**
 * Create a memory and emit `memory:added`.
 *
 * @param {string} agentId
 * @param {Object} entry - { type, content, tags?, context?, salience?, pinned?, expiresAt? }
 * @returns {Promise<Object|null>} the created, decorated memory
 */
export async function addMemory(agentId, entry) {
	if (!agentId) throw new Error('addMemory requires an agentId');
	// Strip any id so the server treats this as a create, not an upsert.
	const rest = { ...(entry || {}) };
	delete rest.id;
	const memory = await upsert(agentId, rest);
	if (memory) {
		agentBus.emit('memory:added', { agentId, memory, ts: isoFrom(memory.createdAt) });
	}
	return memory;
}

/**
 * Update an existing memory (content / salience / pin / visibility / expiry) and
 * emit `memory:updated`. The entry MUST carry its `id`.
 *
 * @param {string} agentId
 * @param {Object} entry - must include `id`
 * @returns {Promise<Object|null>} the updated, decorated memory
 */
export async function updateMemory(agentId, entry) {
	if (!agentId) throw new Error('updateMemory requires an agentId');
	if (!entry?.id) throw new Error('updateMemory requires entry.id');
	const memory = await upsert(agentId, entry);
	if (memory) {
		agentBus.emit('memory:updated', { agentId, memory, ts: isoFrom(memory.updatedAt) });
	}
	return memory;
}

/**
 * Delete a memory and emit `memory:forgotten`.
 *
 * @param {string} agentId - the owning agent (carried in the event for routing)
 * @param {string} memoryId
 * @returns {Promise<boolean>} true on success
 */
export async function forgetMemory(agentId, memoryId) {
	if (!memoryId) throw new Error('forgetMemory requires a memoryId');
	const res = await apiFetch(`/api/agent-memory/${encodeURIComponent(memoryId)}`, {
		method: 'DELETE',
		credentials: 'include',
	});
	if (!res.ok) {
		const j = await readJson(res);
		throw new Error(j.error || `forget failed: ${res.status}`);
	}
	agentBus.emit('memory:forgotten', { agentId: agentId || null, memoryId, ts: new Date().toISOString() });
	return true;
}

/**
 * Emit `memory:recalled` from a chat `done` SSE event's recalled-memory set. The
 * chat endpoint reports exactly which memories it injected into the prompt; this
 * is the single place that turns that server truth into a bus event, so every
 * SSE consumer (avatar page, embedded <agent-3d>, NPC chat) stays consistent. No
 * heuristic guessing — if the server recalled nothing, nothing is emitted.
 *
 * @param {string|null} agentId
 * @param {Object} done - the parsed `{ type:'done', recalled, recalledTs, ... }` event
 * @param {string} [query] - the user message that triggered the recall
 * @returns {Array<Object>} the recalled memories that were emitted (possibly empty)
 */
export function emitRecallFromChat(agentId, done, query) {
	const recalled = Array.isArray(done?.recalled) ? done.recalled : [];
	if (!recalled.length) return [];
	agentBus.emit('memory:recalled', {
		agentId: agentId || null,
		memories: recalled,
		query: query || undefined,
		semantic: Boolean(done.recalledSemantic),
		ts: done.recalledTs || new Date().toISOString(),
	});
	return recalled;
}
