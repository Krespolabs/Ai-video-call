/**
 * Memory Studio — API client (P2)
 * ===============================
 * Thin, typed wrapper over the real memory API surface. Every call goes through
 * the shared `apiFetch` (CSRF + session cookie handled). This is the surface the
 * Memory Studio UI binds to — and the same endpoints P1's Brain Memory node and
 * P4's trade history coordinate against.
 *
 * Endpoints
 *   GET    /api/agent-memory?agentId=          — list (tier/pinned/embedder-aware)
 *   POST   /api/agent-memory                   — add / upsert a memory
 *   POST   /api/memory/search                  — semantic search (mem0 search())
 *   GET    /api/memory/context?agentId=        — working set + token budget
 *   GET    /api/memory/graph?agentId=          — entity knowledge graph
 *   GET    /api/memory/graph?agentId=&entityId= — memories mentioning an entity
 *   POST   /api/memory/curate                  — pin/tier/salience/edit/merge/forget
 */

import { apiFetch } from '../../api.js';

function uuid() {
	return crypto.randomUUID ? crypto.randomUUID()
		: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
		});
}

export class MemoryClient {
	constructor(agentId) {
		this.agentId = agentId;
	}

	async _json(resp) {
		if (!resp.ok) {
			const body = await resp.json().catch(() => ({}));
			throw new Error(body?.error_description || body?.error?.message || body?.error || `HTTP ${resp.status}`);
		}
		return resp.json();
	}

	/** List all memories for the agent (newest first). */
	async list({ limit = 500, type } = {}) {
		const params = new URLSearchParams({ agentId: this.agentId, limit: String(limit) });
		if (type) params.set('type', type);
		const resp = await apiFetch(`/api/agent-memory?${params}`);
		const { entries } = await this._json(resp);
		return entries || [];
	}

	/** Add a memory. Returns the created/updated entry. */
	async add(entry) {
		const payload = {
			id: entry.id || uuid(),
			type: entry.type || 'project',
			content: entry.content,
			tags: entry.tags || [],
			salience: entry.salience ?? 0.5,
			tier: entry.tier,
			pinned: entry.pinned === true,
			context: entry.context || {},
		};
		const resp = await apiFetch('/api/agent-memory', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agentId: this.agentId, entry: payload }),
		});
		const { entry: saved } = await this._json(resp);
		return saved;
	}

	/** Semantic search across the tiered store. */
	async search(query, { topK = 12, minScore = 0.25, tiers, type } = {}) {
		const resp = await apiFetch('/api/memory/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agentId: this.agentId, query, topK, minScore, tiers, type }),
		});
		return this._json(resp);
	}

	/** The working set in context now + token budget. */
	async context() {
		const resp = await apiFetch(`/api/memory/context?agentId=${encodeURIComponent(this.agentId)}`);
		return this._json(resp);
	}

	/** The entity knowledge graph (nodes + co-occurrence edges). */
	async graph() {
		const resp = await apiFetch(`/api/memory/graph?agentId=${encodeURIComponent(this.agentId)}`);
		return this._json(resp);
	}

	/** Memories that mention one entity (graph drilldown / trade-aware queries). */
	async entityMemories(entityId) {
		const params = new URLSearchParams({ agentId: this.agentId, entityId });
		const resp = await apiFetch(`/api/memory/graph?${params}`);
		const { memories } = await this._json(resp);
		return memories || [];
	}

	/** Curation ops. */
	async curate(op, payload = {}) {
		const resp = await apiFetch('/api/memory/curate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agentId: this.agentId, op, ...payload }),
		});
		return this._json(resp);
	}

	pin(memoryId) { return this.curate('pin', { memoryId }); }
	unpin(memoryId) { return this.curate('unpin', { memoryId }); }
	setTier(memoryId, tier) { return this.curate('tier', { memoryId, tier }); }
	setSalience(memoryId, salience) { return this.curate('salience', { memoryId, salience }); }
	edit(memoryId, fields) { return this.curate('edit', { memoryId, ...fields }); }
	merge(memoryIds) { return this.curate('merge', { memoryIds }); }
	forget(memoryId) { return this.curate('forget', { memoryId }); }
}
