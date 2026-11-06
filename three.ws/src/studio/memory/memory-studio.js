/**
 * Memory Studio — controller (P2)
 * ===============================
 * The visual memory surface: watch memories form, curate them, and trust them.
 * Mounts into the Agent Studio shell's Memory tab and wires:
 *   • Timeline   — a live, scrollable stream of memories forming over time, with
 *                  pin / edit / merge / forget / salience / tier curation.
 *   • Graph      — the temporal knowledge graph (entities + co-occurrence edges),
 *                  with per-entity drilldown + "memory replay" (how the agent's
 *                  understanding of a coin evolved over time).
 *   • In context — the working set + live token budget: exactly what the agent
 *                  carries into every reply.
 *   • Recall     — real semantic search (mem0 search()) with scores + trade-aware
 *                  quick queries.
 *
 * Every write flows through the real API and emits `studio.emit('memory:change')`
 * + a market event so the Brain (P1) and the live avatar react.
 *
 * Mount: import { mountMemoryStudio } from './memory/memory-studio.js';
 *        mountMemoryStudio(container, { studio });
 */

import { MemoryClient } from './memory-client.js';
import { MemoryGraph } from './memory-graph.js';
import { fetchConnector, synthesizeMemorySeed, saveMemoryToAgent } from '../../memory-seed.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function relTime(ts) {
	if (!ts) return '';
	const d = Date.now() - ts;
	if (d < 0) return 'just now';
	if (d < 60000) return 'just now';
	if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
	if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
	if (d < 2592000000) return Math.floor(d / 86400000) + 'd ago';
	return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const TYPE_LABEL = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };
const TIERS = [
	{ key: 'working', label: 'Working', hint: 'Always in context — the core.' },
	{ key: 'recall', label: 'Recall', hint: 'Recent, searchable.' },
	{ key: 'archival', label: 'Archival', hint: 'Long-term, semantic.' },
];
const KIND_LABEL = { mint: 'Coins', ticker: 'Tickers', wallet: 'Wallets', person: 'People', strategy: 'Strategies', topic: 'Topics' };

export function mountMemoryStudio(container, { studio }) {
	if (container.dataset.memoryMounted) return;
	container.dataset.memoryMounted = '1';
	container.querySelector('.studio-empty')?.remove();
	return new MemoryStudio(container, studio);
}

class MemoryStudio {
	constructor(el, studio) {
		this.el = el;
		this.studio = studio;
		this.agentId = studio.agent?.id;
		this.client = new MemoryClient(this.agentId);

		this.state = {
			view: 'timeline',
			loading: true,
			error: null,
			memories: [],
			context: null,
			graph: null,
			filter: { type: '', tier: '', q: '' },
			selection: new Set(),
			mergeMode: false,
			search: null, // { query, results, provider, scored }
			entity: null, // { node, memories, replay }
			renderLimit: 60,
		};
		this._knownIds = new Set();
		this._graph = null;

		this._render();
		this._load();
	}

	// ── Data ────────────────────────────────────────────────────────────────

	async _load() {
		this.state.loading = true;
		this._renderBody();
		try {
			const [memories, context] = await Promise.all([
				this.client.list(),
				this.client.context().catch(() => null),
			]);
			this.state.memories = memories;
			this.state.context = context;
			this.state.loading = false;
			this.state.error = null;
			memories.forEach((m) => this._knownIds.add(m.id));
			this._renderQuick();
		} catch (err) {
			this.state.loading = false;
			this.state.error = err.message || 'Could not load memories.';
		}
		this._renderBody();
	}

	async _refreshContext() {
		this.state.context = await this.client.context().catch(() => this.state.context);
		if (this.state.view === 'context') this._renderBody();
		this._renderQuick();
	}

	_emitChange(detail) {
		try { this.studio.emit('memory:change', detail || {}); } catch {}
	}

	// ── Shell ─────────────────────────────────────────────────────────────────

	_render() {
		this.el.innerHTML = `
			<div class="mem">
				<header class="mem-top">
					<form class="mem-recall" data-recall-form role="search">
						<svg class="mem-recall-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 21l-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
						<input class="mem-recall-input" data-search type="search" autocomplete="off"
							placeholder="Recall — ask what your agent knows…" aria-label="Search memories" />
						<button class="mem-btn mem-btn-accent" type="submit" data-do-search>Recall</button>
					</form>
					<div class="mem-quick" data-quick aria-label="Quick recalls"></div>
					<div class="mem-toolbar">
						<nav class="mem-views" role="tablist" aria-label="Memory views">
							<button class="mem-view active" role="tab" data-view="timeline" aria-selected="true">Timeline</button>
							<button class="mem-view" role="tab" data-view="graph" aria-selected="false">Graph</button>
							<button class="mem-view" role="tab" data-view="context" aria-selected="false">In context</button>
						</nav>
						<div class="mem-actions">
							<button class="mem-btn mem-btn-ghost" data-action="seed" title="Synthesize memory from your accounts">Seed</button>
							<button class="mem-btn" data-action="add" title="Add a memory">+ Memory</button>
						</div>
					</div>
				</header>
				<div class="mem-subbar" data-subbar></div>
				<div class="mem-body" data-body tabindex="0"></div>
				<div class="mem-merge-bar" data-merge-bar hidden>
					<span data-merge-count>0 selected</span>
					<button class="mem-btn mem-btn-sm" data-action="merge-commit">Merge into oldest</button>
					<button class="mem-btn mem-btn-sm mem-btn-ghost" data-action="merge-cancel">Cancel</button>
				</div>
				<div class="mem-toast" data-toast hidden></div>
			</div>`;
		this._bind();
		this._renderSubbar();
	}

	_q(sel) { return this.el.querySelector(sel); }

	_bind() {
		this.el.querySelector('[data-recall-form]').addEventListener('submit', (e) => {
			e.preventDefault();
			this._runSearch(this._q('[data-search]').value.trim());
		});
		this._q('[data-search]').addEventListener('input', (e) => {
			if (!e.target.value.trim() && this.state.search) {
				this.state.search = null;
				this._renderBody();
			}
		});
		this.el.querySelectorAll('[data-view]').forEach((b) =>
			b.addEventListener('click', () => this._selectView(b.dataset.view)));
		this.el.querySelector('.mem-actions').addEventListener('click', (e) => {
			const btn = e.target.closest('[data-action]');
			if (!btn) return;
			if (btn.dataset.action === 'add') this._openAddForm();
			if (btn.dataset.action === 'seed') this._openSeed();
		});
		this._q('[data-merge-bar]').addEventListener('click', (e) => {
			const a = e.target.closest('[data-action]')?.dataset.action;
			if (a === 'merge-commit') this._commitMerge();
			if (a === 'merge-cancel') this._exitMergeMode();
		});
		// Delegated curation + interactions on the body. Bound on the persistent
		// body element so they survive inner re-renders.
		const body = this._q('[data-body]');
		body.addEventListener('click', (e) => this._onBodyClick(e));
		body.addEventListener('scroll', () => this._onScroll());
		body.addEventListener('change', (e) => {
			const act = e.target.closest('[data-act]');
			const id = e.target.closest('[data-id]')?.dataset.id;
			if (act && id && act.dataset.act === 'tier') this._setTier(id, e.target.value);
		});
		body.addEventListener('input', (e) => {
			const act = e.target.closest('[data-act="salience"]');
			const id = e.target.closest('[data-id]')?.dataset.id;
			if (!act || !id) return;
			const val = Number(e.target.value) / 100;
			const label = e.target.parentElement.querySelector('.mem-sal-val');
			if (label) label.textContent = val.toFixed(2);
			clearTimeout(this._salTimer);
			this._salTimer = setTimeout(() => this._setSalience(id, val), 350);
		});
	}

	_selectView(view) {
		// Tear down the graph sim (RAF + window/canvas listeners) when leaving it.
		if (view !== 'graph' && this._graph) { this._graph.destroy(); this._graph = null; }
		this.state.view = view;
		this.state.search = null;
		this.state.entity = null;
		this.el.querySelectorAll('[data-view]').forEach((b) => {
			const on = b.dataset.view === view;
			b.classList.toggle('active', on);
			b.setAttribute('aria-selected', String(on));
		});
		this._renderSubbar();
		this._renderBody();
	}

	// ── Quick recalls (trade-aware) ─────────────────────────────────────────────

	_renderQuick() {
		const host = this._q('[data-quick]');
		if (!host) return;
		const chips = [
			{ q: 'lessons from losing trades', label: 'Lessons from losses' },
			{ q: 'rules my agent follows', label: 'Rules it follows' },
			{ q: 'winning trades', label: 'Wins' },
			{ q: 'watchlist', label: 'Watchlist' },
		];
		host.innerHTML = chips
			.map((c) => `<button class="mem-chip" data-quick-q="${esc(c.q)}">${esc(c.label)}</button>`)
			.join('');
		host.querySelectorAll('[data-quick-q]').forEach((b) =>
			b.addEventListener('click', () => {
				this._q('[data-search]').value = b.dataset.quickQ;
				this._runSearch(b.dataset.quickQ);
			}));
	}

	// ── Subbar (per view) ──────────────────────────────────────────────────────

	_renderSubbar() {
		const host = this._q('[data-subbar]');
		if (this.state.view === 'timeline') {
			const f = this.state.filter;
			const typePills = ['', 'user', 'feedback', 'project', 'reference']
				.map((t) => `<button class="mem-pill ${f.type === t ? 'active' : ''}" data-filter-type="${t}">${t ? TYPE_LABEL[t] : 'All types'}</button>`)
				.join('');
			const tierPills = ['', ...TIERS.map((t) => t.key)]
				.map((t) => `<button class="mem-pill ${f.tier === t ? 'active' : ''}" data-filter-tier="${t}">${t ? TIERS.find((x) => x.key === t).label : 'All tiers'}</button>`)
				.join('');
			host.innerHTML = `
				<div class="mem-filters">${typePills}</div>
				<div class="mem-filters">${tierPills}</div>
				<button class="mem-pill mem-pill-ghost ${this.state.mergeMode ? 'active' : ''}" data-action="merge-toggle" title="Select duplicates to merge">⛙ Merge</button>`;
			host.querySelectorAll('[data-filter-type]').forEach((b) => b.addEventListener('click', () => {
				this.state.filter.type = b.dataset.filterType; this.state.renderLimit = 60; this._renderSubbar(); this._renderBody();
			}));
			host.querySelectorAll('[data-filter-tier]').forEach((b) => b.addEventListener('click', () => {
				this.state.filter.tier = b.dataset.filterTier; this.state.renderLimit = 60; this._renderSubbar(); this._renderBody();
			}));
			host.querySelector('[data-action="merge-toggle"]').addEventListener('click', () => this._toggleMergeMode());
			host.hidden = false;
		} else if (this.state.view === 'context') {
			host.innerHTML = `<p class="mem-subbar-note">This is the working core — exactly what your agent carries into every reply. Pin memories to add them; the token budget keeps the core small and trustworthy.</p>`;
			host.hidden = false;
		} else {
			host.hidden = true;
			host.innerHTML = '';
		}
	}

	// ── Body dispatch ────────────────────────────────────────────────────────

	_renderBody() {
		const host = this._q('[data-body]');
		if (this.state.loading) return void (host.innerHTML = this._skeleton());
		if (this.state.error) return void (host.innerHTML = this._errorState(this.state.error));
		if (this.state.search) return void this._renderSearch(host);
		if (this.state.entity) return void this._renderEntity(host);
		if (this.state.view === 'graph') return void this._renderGraph(host);
		if (this.state.view === 'context') return void this._renderContext(host);
		return void this._renderTimeline(host);
	}

	_skeleton() {
		return `<div class="mem-skel">${'<div class="mem-skel-row"></div>'.repeat(5)}</div>`;
	}

	_errorState(msg) {
		return `<div class="mem-empty"><div class="mem-empty-glyph">⚠</div><h3>Couldn’t load memory</h3><p>${esc(msg)}</p><button class="mem-btn" data-action="retry">Try again</button></div>`;
	}

	// ── Timeline ──────────────────────────────────────────────────────────────

	_filteredMemories() {
		const f = this.state.filter;
		return this.state.memories.filter((m) => {
			if (f.type && m.type !== f.type) return false;
			if (f.tier && (m.tier || 'recall') !== f.tier) return false;
			return true;
		}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	}

	_renderTimeline(host) {
		const all = this._filteredMemories();
		if (!this.state.memories.length) return void (host.innerHTML = this._firstRun());
		if (!all.length) {
			host.innerHTML = `<div class="mem-empty"><div class="mem-empty-glyph">⊘</div><h3>No memories match</h3><p>Clear the filters to see the full stream.</p></div>`;
			return;
		}
		const slice = all.slice(0, this.state.renderLimit);
		const more = all.length - slice.length;
		host.innerHTML = `
			<ol class="mem-stream" aria-label="Memory timeline">
				${slice.map((m) => this._card(m)).join('')}
			</ol>
			${more > 0 ? `<div class="mem-more">Showing ${slice.length} of ${all.length} — scroll for ${more} more</div>` : ''}`;
		// Mark newly arrived for entrance animation, then remember them so they
		// only animate once (a filter re-render won't re-trigger the entrance).
		host.querySelectorAll('.mem-card--new').forEach((c) => {
			requestAnimationFrame(() => c.classList.remove('mem-card--new'));
		});
		slice.forEach((m) => this._knownIds.add(m.id));
	}

	_card(m) {
		const isNew = !this._knownIds.has(m.id);
		const sal = Math.round((m.salience || 0) * 100);
		const tier = m.tier || 'recall';
		const selected = this.state.selection.has(m.id);
		const tags = (m.tags || []).filter((t) => t !== 'studio' && t !== 'chat');
		return `
			<li class="mem-card mem-card--${esc(m.type)} ${isNew ? 'mem-card--new' : ''} ${selected ? 'mem-card--sel' : ''}" data-id="${esc(m.id)}">
				${this.state.mergeMode ? `<input type="checkbox" class="mem-card-check" data-act="select" ${selected ? 'checked' : ''} aria-label="Select for merge" />` : ''}
				<div class="mem-card-rail" data-tier="${esc(tier)}" title="${esc(TIERS.find((t) => t.key === tier)?.hint || '')}"></div>
				<div class="mem-card-main">
					<div class="mem-card-head">
						<span class="mem-badge" data-type="${esc(m.type)}">${esc(TYPE_LABEL[m.type] || m.type)}</span>
						<span class="mem-tier-tag" data-tier="${esc(tier)}">${esc(TIERS.find((t) => t.key === tier)?.label || tier)}</span>
						${m.pinned ? '<span class="mem-pin-on" title="Pinned to working core">★</span>' : ''}
						${m.hasEmbedding ? '<span class="mem-embed-dot" title="Embedded — semantically searchable"></span>' : '<span class="mem-embed-dot pending" title="Embedding pending"></span>'}
						<span class="mem-card-time">${esc(relTime(m.createdAt))}</span>
					</div>
					<div class="mem-card-content" data-act="expand">${esc(m.content)}</div>
					<div class="mem-card-foot">
						<div class="mem-tags">${tags.map((t) => `<span class="mem-tag" data-act="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>
						<div class="mem-sal">
							<input class="mem-sal-range" type="range" min="0" max="100" value="${sal}" data-act="salience" aria-label="Salience" />
							<span class="mem-sal-val">${(m.salience || 0).toFixed(2)}</span>
						</div>
					</div>
					<div class="mem-card-tools">
						<button class="mem-tool" data-act="${m.pinned ? 'unpin' : 'pin'}" title="${m.pinned ? 'Unpin from core' : 'Pin to working core'}">${m.pinned ? '★ Pinned' : '☆ Pin'}</button>
						<select class="mem-tool-select" data-act="tier" aria-label="Tier">
							${TIERS.map((t) => `<option value="${t.key}" ${t.key === tier ? 'selected' : ''}>${t.label}</option>`).join('')}
						</select>
						<button class="mem-tool" data-act="edit" title="Edit">Edit</button>
						<button class="mem-tool mem-tool-danger" data-act="forget" title="Forget">Forget</button>
						${m.accessCount ? `<span class="mem-recalls" title="Times recalled">↺ ${m.accessCount}</span>` : ''}
					</div>
				</div>
			</li>`;
	}

	_firstRun() {
		return `
			<div class="mem-first">
				<div class="mem-first-glyph">◍</div>
				<h3>Your agent has no memories yet</h3>
				<p>Memory is what turns a chatbot into a companion that knows you — and a trader that remembers every snipe, win, loss, and rule. Give it something to remember.</p>
				<div class="mem-tier-legend">
					${TIERS.map((t) => `<div class="mem-tier-card" data-tier="${t.key}"><strong>${t.label}</strong><span>${t.hint}</span></div>`).join('')}
				</div>
				<div class="mem-first-cta">
					<button class="mem-btn mem-btn-accent" data-action="seed">Seed from your accounts</button>
					<button class="mem-btn mem-btn-ghost" data-action="add">Add a memory manually</button>
				</div>
			</div>`;
	}

	// ── Graph ──────────────────────────────────────────────────────────────────

	async _renderGraph(host) {
		host.innerHTML = `
			<div class="mem-graph-wrap">
				<canvas class="mem-graph-canvas" data-graph-canvas></canvas>
				<div class="mem-graph-legend">
					${Object.entries(KIND_LABEL).map(([k, label]) =>
						`<span class="mem-legend-item"><i style="background:${MemoryGraph.color(k)}"></i>${esc(label)}</span>`).join('')}
				</div>
				<div class="mem-graph-empty" data-graph-empty hidden>
					<p>No entities yet. As your agent remembers coins, wallets, people and strategies, they’ll appear here — linked by what shows up together.</p>
				</div>
			</div>`;
		const canvas = host.querySelector('[data-graph-canvas]');
		if (this._graph) this._graph.destroy();
		this._graph = new MemoryGraph(canvas, { onSelect: (node) => this._onGraphSelect(node) });

		try {
			const graph = this.state.graph || (this.state.graph = await this.client.graph());
			if (!graph.nodes?.length) {
				host.querySelector('[data-graph-empty]').hidden = false;
				return;
			}
			this._graph.setData(graph);
		} catch (err) {
			host.querySelector('[data-graph-empty]').hidden = false;
			host.querySelector('[data-graph-empty]').innerHTML = `<p>Couldn’t build the graph: ${esc(err.message)}</p>`;
		}
	}

	async _onGraphSelect(node) {
		if (!node) return;
		const memories = await this.client.entityMemories(node.id).catch(() => []);
		this.state.entity = { node, memories, replay: false };
		this._renderBody();
	}

	_renderEntity(host) {
		const { node, memories, replay } = this.state.entity;
		const ordered = replay
			? [...memories].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
			: [...memories].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
		const isCoin = node.kind === 'mint' || node.kind === 'ticker';
		host.innerHTML = `
			<div class="mem-entity">
				<div class="mem-entity-head">
					<button class="mem-back" data-act="entity-back">← Back</button>
					<span class="mem-entity-kind" style="--c:${MemoryGraph.color(node.kind)}">${esc(KIND_LABEL[node.kind] || node.kind)}</span>
					<h3>${esc(node.label)}</h3>
					<span class="mem-entity-stat">${node.mentions} mention${node.mentions === 1 ? '' : 's'}</span>
					${isCoin ? `<button class="mem-btn mem-btn-sm ${replay ? 'mem-btn-accent' : 'mem-btn-ghost'}" data-act="entity-replay">${replay ? '▶ Replaying' : '⟳ Replay'}</button>` : ''}
				</div>
				${replay ? `<p class="mem-entity-replay-note">Watch how your agent’s understanding of <strong>${esc(node.label)}</strong> formed — oldest memory first.</p>` : ''}
				${ordered.length
					? `<ol class="mem-stream mem-stream-compact">${ordered.map((m, i) => this._replayCard(m, replay ? i + 1 : null)).join('')}</ol>`
					: '<div class="mem-empty"><p>No memories reference this entity yet.</p></div>'}
			</div>`;
	}

	_replayCard(m, step) {
		return `
			<li class="mem-card mem-card--${esc(m.type)}" data-id="${esc(m.id)}">
				<div class="mem-card-rail" data-tier="${esc(m.tier || 'recall')}"></div>
				<div class="mem-card-main">
					<div class="mem-card-head">
						${step ? `<span class="mem-step">${step}</span>` : ''}
						<span class="mem-badge" data-type="${esc(m.type)}">${esc(TYPE_LABEL[m.type] || m.type)}</span>
						<span class="mem-card-time">${esc(relTime(m.createdAt))}</span>
					</div>
					<div class="mem-card-content">${esc(m.content)}</div>
				</div>
			</li>`;
	}

	// ── In context ──────────────────────────────────────────────────────────────

	_renderContext(host) {
		const ctx = this.state.context;
		if (!ctx) { host.innerHTML = this._skeleton(); this._refreshContext(); return; }
		const pct = Math.min(100, Math.round((ctx.tokens / ctx.budget) * 100));
		const c = ctx.counts || {};
		host.innerHTML = `
			<div class="mem-ctx">
				<div class="mem-ctx-budget ${ctx.overBudget ? 'over' : ''}">
					<div class="mem-ctx-budget-top">
						<span>Working core</span>
						<span class="mem-ctx-tokens">${ctx.tokens} / ${ctx.budget} tokens</span>
					</div>
					<div class="mem-ctx-bar"><div class="mem-ctx-fill" style="width:${pct}%"></div></div>
					${ctx.overBudget ? '<p class="mem-ctx-warn">Over budget — unpin or archive low-value memories so the core stays sharp.</p>' : ''}
				</div>
				<div class="mem-ctx-counts">
					<div class="mem-count"><b>${c.total ?? 0}</b><span>total</span></div>
					<div class="mem-count" data-tier="working"><b>${c.working ?? 0}</b><span>working</span></div>
					<div class="mem-count" data-tier="recall"><b>${c.recall ?? 0}</b><span>recall</span></div>
					<div class="mem-count" data-tier="archival"><b>${c.archival ?? 0}</b><span>archival</span></div>
					<div class="mem-count"><b>${c.embedded ?? 0}</b><span>embedded</span></div>
				</div>
				<h4 class="mem-ctx-title">In context right now</h4>
				${ctx.entries.length
					? `<ol class="mem-stream mem-stream-compact">${ctx.entries.map((m) => this._card(m)).join('')}</ol>`
					: '<div class="mem-empty"><p>Nothing pinned to the working core yet. Pin your agent’s identity, goals, and key rules so they’re always present.</p></div>'}
			</div>`;
	}

	// ── Search / recall ──────────────────────────────────────────────────────────

	async _runSearch(query) {
		if (!query) return;
		this.state.search = { query, results: [], provider: false, scored: 0, loading: true };
		this._renderBody();
		try {
			const out = await this.client.search(query, { topK: 15, minScore: 0.2 });
			this.state.search = { query, ...out, loading: false };
		} catch (err) {
			this.state.search = { query, results: [], error: err.message, loading: false };
		}
		this._renderBody();
	}

	_renderSearch(host) {
		const s = this.state.search;
		if (s.loading) { host.innerHTML = this._skeleton(); return; }
		const provNote = s.provider
			? `<span class="mem-search-note">semantic · ${s.scored} scored</span>`
			: '<span class="mem-search-note">keyword match (no embedding provider configured)</span>';
		host.innerHTML = `
			<div class="mem-search-head">
				<button class="mem-back" data-act="search-back">← Back</button>
				<h3>Recall: “${esc(s.query)}”</h3>
				${provNote}
			</div>
			${s.error ? `<div class="mem-empty"><p>${esc(s.error)}</p></div>`
				: s.results.length
					? `<ol class="mem-stream">${s.results.map((m) => this._searchCard(m)).join('')}</ol>`
					: `<div class="mem-empty"><div class="mem-empty-glyph">∅</div><h3>Nothing recalled</h3><p>Your agent has no memory matching that yet.</p></div>`}`;
	}

	_searchCard(m) {
		const scoreTag = m.match === 'semantic' && m.score != null
			? `<span class="mem-score" title="cosine similarity">${(m.score * 100).toFixed(0)}%</span>`
			: '<span class="mem-score mem-score-lex">keyword</span>';
		return `
			<li class="mem-card mem-card--${esc(m.type)}" data-id="${esc(m.id)}">
				<div class="mem-card-rail" data-tier="${esc(m.tier || 'recall')}"></div>
				<div class="mem-card-main">
					<div class="mem-card-head">
						<span class="mem-badge" data-type="${esc(m.type)}">${esc(TYPE_LABEL[m.type] || m.type)}</span>
						${scoreTag}
						<span class="mem-card-time">${esc(relTime(m.createdAt))}</span>
					</div>
					<div class="mem-card-content">${esc(m.content)}</div>
				</div>
			</li>`;
	}

	// ── Body interactions ──────────────────────────────────────────────────────

	_onScroll() {
		if (this.state.view !== 'timeline' || this.state.search || this.state.entity) return;
		const host = this._q('[data-body]');
		if (host.scrollTop + host.clientHeight >= host.scrollHeight - 200) {
			const total = this._filteredMemories().length;
			if (this.state.renderLimit < total) {
				this.state.renderLimit += 60;
				this._renderTimeline(host);
			}
		}
	}

	async _onBodyClick(e) {
		const actionBtn = e.target.closest('[data-action]');
		if (actionBtn) {
			const a = actionBtn.dataset.action;
			if (a === 'retry') return this._load();
			if (a === 'seed') return this._openSeed();
			if (a === 'add') return this._openAddForm();
		}
		const act = e.target.closest('[data-act]');
		if (!act) return;
		const card = e.target.closest('[data-id]');
		const id = card?.dataset.id;
		const op = act.dataset.act;

		if (op === 'entity-back') { this.state.entity = null; return this._renderBody(); }
		if (op === 'search-back') { this.state.search = null; return this._renderBody(); }
		if (op === 'entity-replay') {
			this.state.entity.replay = !this.state.entity.replay;
			return this._renderBody();
		}
		if (op === 'expand') { card.querySelector('.mem-card-content').classList.toggle('expanded'); return; }
		if (op === 'tag') { this._q('[data-search]').value = act.dataset.tag; return this._runSearch(act.dataset.tag); }
		if (!id) return;

		if (op === 'select') return this._toggleSelect(id, card);
		if (op === 'pin') return this._mutate(id, () => this.client.pin(id), 'Pinned to working core');
		if (op === 'unpin') return this._mutate(id, () => this.client.unpin(id), 'Unpinned');
		if (op === 'forget') return this._forget(id, card);
		if (op === 'edit') return this._inlineEdit(id, card);
	}

	// ── Mutations ────────────────────────────────────────────────────────────

	_localUpdate(entry) {
		if (!entry) return;
		const i = this.state.memories.findIndex((m) => m.id === entry.id);
		if (i >= 0) this.state.memories[i] = { ...this.state.memories[i], ...entry };
	}

	async _mutate(id, fn, toast) {
		try {
			const { entry } = await fn();
			this._localUpdate(entry);
			this._emitChange({ op: 'curate', id });
			this.studio.emitMarket?.({ type: 'memory:saved' });
			if (toast) this._toast(toast);
			this._renderBody();
			this._refreshContext();
		} catch (err) {
			this._toast(err.message || 'Update failed', true);
		}
	}

	async _forget(id, card) {
		if (card) card.classList.add('mem-card--leaving');
		try {
			await this.client.forget(id);
			this.state.memories = this.state.memories.filter((m) => m.id !== id);
			this.state.graph = null; // graph derived from memories — invalidate
			this._knownIds.delete(id);
			this._emitChange({ op: 'forget', id });
			setTimeout(() => { this._renderBody(); this._refreshContext(); }, 180);
		} catch (err) {
			if (card) card.classList.remove('mem-card--leaving');
			this._toast(err.message || 'Could not forget', true);
		}
	}

	async _setSalience(id, value) {
		try {
			const { entry } = await this.client.setSalience(id, value);
			this._localUpdate(entry);
			this._emitChange({ op: 'salience', id });
		} catch (err) { this._toast(err.message, true); }
	}

	async _setTier(id, tier) {
		await this._mutate(id, () => this.client.setTier(id, tier), `Moved to ${tier}`);
	}

	_inlineEdit(id, card) {
		const mem = this.state.memories.find((m) => m.id === id);
		if (!mem) return;
		const main = card.querySelector('.mem-card-main');
		const tags = (mem.tags || []).join(', ');
		main.innerHTML = `
			<div class="mem-edit">
				<textarea class="mem-edit-content" rows="4">${esc(mem.content)}</textarea>
				<input class="mem-edit-tags" type="text" value="${esc(tags)}" placeholder="tags, comma separated" />
				<div class="mem-edit-tools">
					<button class="mem-btn mem-btn-sm" data-edit-save>Save</button>
					<button class="mem-btn mem-btn-sm mem-btn-ghost" data-edit-cancel>Cancel</button>
				</div>
			</div>`;
		main.querySelector('[data-edit-cancel]').addEventListener('click', () => this._renderBody());
		main.querySelector('[data-edit-save]').addEventListener('click', async () => {
			const content = main.querySelector('.mem-edit-content').value.trim();
			const newTags = main.querySelector('.mem-edit-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
			if (!content) return;
			try {
				const { entry } = await this.client.edit(id, { content, tags: newTags });
				this._localUpdate(entry);
				this.state.graph = null;
				this._emitChange({ op: 'edit', id });
				this._toast('Memory updated — re-indexing');
				this._renderBody();
			} catch (err) { this._toast(err.message, true); }
		});
	}

	// ── Merge mode ──────────────────────────────────────────────────────────

	_toggleMergeMode() {
		this.state.mergeMode = !this.state.mergeMode;
		if (!this.state.mergeMode) this.state.selection.clear();
		this._renderSubbar();
		this._renderBody();
		this._updateMergeBar();
	}
	_exitMergeMode() { this.state.mergeMode = false; this.state.selection.clear(); this._renderSubbar(); this._renderBody(); this._updateMergeBar(); }

	_toggleSelect(id, card) {
		if (this.state.selection.has(id)) this.state.selection.delete(id);
		else this.state.selection.add(id);
		card?.classList.toggle('mem-card--sel', this.state.selection.has(id));
		this._updateMergeBar();
	}

	_updateMergeBar() {
		const bar = this._q('[data-merge-bar]');
		const n = this.state.selection.size;
		bar.hidden = !this.state.mergeMode || n < 1;
		this._q('[data-merge-count]').textContent = `${n} selected`;
		const mergeBtn = bar.querySelector('[data-action="merge-commit"]');
		if (mergeBtn) mergeBtn.disabled = n < 2;
	}

	async _commitMerge() {
		const ids = [...this.state.selection];
		if (ids.length < 2) return this._toast('Select at least two memories', true);
		// Target = oldest (the original); fold the rest into it.
		const ordered = ids
			.map((id) => this.state.memories.find((m) => m.id === id))
			.filter(Boolean)
			.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
			.map((m) => m.id);
		try {
			const { entry, merged } = await this.client.merge(ordered);
			const removed = new Set(ordered.slice(1));
			this.state.memories = this.state.memories.filter((m) => !removed.has(m.id));
			this._localUpdate(entry);
			this.state.graph = null;
			this._emitChange({ op: 'merge', id: entry.id });
			this._toast(`Merged ${merged + 1} memories`);
			this._exitMergeMode();
		} catch (err) { this._toast(err.message, true); }
	}

	// ── Add form ────────────────────────────────────────────────────────────────

	_openAddForm() {
		const host = this._q('[data-body]');
		host.scrollTop = 0;
		// A transient composer pinned above the stream.
		let composer = this.el.querySelector('.mem-composer');
		if (composer) { composer.querySelector('textarea')?.focus(); return; }
		composer = document.createElement('div');
		composer.className = 'mem-composer';
		composer.innerHTML = `
			<div class="mem-composer-row">
				<select class="mem-composer-type" aria-label="Type">
					${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${k === 'project' ? 'selected' : ''}>${l}</option>`).join('')}
				</select>
				<select class="mem-composer-tier" aria-label="Tier">
					${TIERS.map((t) => `<option value="${t.key}" ${t.key === 'recall' ? 'selected' : ''}>${t.label}</option>`).join('')}
				</select>
				<label class="mem-composer-pin"><input type="checkbox" class="mem-composer-pinned" /> Pin</label>
			</div>
			<textarea class="mem-composer-content" rows="3" placeholder="What should your agent remember? (a rule, a preference, a lesson from a trade…)"></textarea>
			<input class="mem-composer-tags" type="text" placeholder="tags, comma separated" />
			<div class="mem-composer-tools">
				<button class="mem-btn mem-btn-sm" data-composer-save>Remember it</button>
				<button class="mem-btn mem-btn-sm mem-btn-ghost" data-composer-cancel>Cancel</button>
			</div>`;
		host.prepend(composer);
		composer.querySelector('textarea').focus();
		composer.querySelector('[data-composer-cancel]').addEventListener('click', () => composer.remove());
		composer.querySelector('[data-composer-save]').addEventListener('click', async () => {
			const content = composer.querySelector('.mem-composer-content').value.trim();
			if (!content) return;
			const pinned = composer.querySelector('.mem-composer-pinned').checked;
			const entry = {
				type: composer.querySelector('.mem-composer-type').value,
				tier: composer.querySelector('.mem-composer-tier').value,
				pinned,
				content,
				tags: composer.querySelector('.mem-composer-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
				salience: pinned ? 0.85 : 0.6,
			};
			composer.querySelector('[data-composer-save]').disabled = true;
			await this._addMemory(entry);
			composer.remove();
		});
	}

	async _addMemory(entry) {
		try {
			const saved = await this.client.add(entry);
			if (saved) {
				this.state.memories.unshift(saved);
				this.state.graph = null;
				this._emitChange({ op: 'add', id: saved.id });
				this.studio.emitMarket?.({ type: 'memory:saved' });
				this._learned(saved);
			}
			if (this.state.view !== 'timeline') this._selectView('timeline');
			else this._renderBody();
			this._refreshContext();
		} catch (err) { this._toast(err.message || 'Could not save', true); }
	}

	// ── Seed from connectors ──────────────────────────────────────────────────────

	_openSeed() {
		if (this.el.querySelector('.mem-seed-modal')) return;
		const modal = document.createElement('div');
		modal.className = 'mem-seed-modal';
		modal.innerHTML = `
			<div class="mem-seed-card" role="dialog" aria-label="Seed memory">
				<div class="mem-seed-head"><h3>Seed memory from your accounts</h3><button class="mem-seed-x" data-seed-close aria-label="Close">×</button></div>
				<p class="mem-seed-sub">Pull a real identity from GitHub, X, and Farcaster, synthesize it with Claude, and save it as your agent’s pinned working memory.</p>
				<div class="mem-seed-conns">
					${['github', 'x', 'farcaster'].map((n) => `
						<div class="mem-seed-conn">
							<label>${n === 'github' ? 'GitHub' : n === 'x' ? 'X' : 'Farcaster'}</label>
							<input data-seed-input="${n}" type="text" placeholder="${n === 'farcaster' ? 'username or fid' : 'handle'}" autocomplete="off" />
							<span class="mem-seed-dot" data-seed-dot="${n}"></span>
						</div>`).join('')}
				</div>
				<button class="mem-btn mem-btn-accent mem-btn-full" data-seed-go>Fetch & synthesize</button>
				<div class="mem-seed-out" data-seed-out hidden></div>
				<div class="mem-seed-tools" data-seed-save-tools hidden>
					<button class="mem-btn mem-btn-sm" data-seed-save>Save as pinned memory</button>
					<span class="mem-seed-notice" data-seed-notice></span>
				</div>
			</div>`;
		this.el.appendChild(modal);
		modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
		modal.querySelector('[data-seed-close]').addEventListener('click', () => modal.remove());

		let seedMarkdown = '';
		modal.querySelector('[data-seed-go]').addEventListener('click', async () => {
			const connectors = {};
			const names = ['github', 'x', 'farcaster'];
			const go = modal.querySelector('[data-seed-go]');
			go.disabled = true; go.textContent = 'Fetching…';
			await Promise.all(names.map(async (n) => {
				const handle = modal.querySelector(`[data-seed-input="${n}"]`).value.trim();
				const dot = modal.querySelector(`[data-seed-dot="${n}"]`);
				if (!handle) return;
				dot.className = 'mem-seed-dot loading';
				try { connectors[n] = await fetchConnector(n, handle); dot.className = 'mem-seed-dot ok'; }
				catch { dot.className = 'mem-seed-dot err'; }
			}));
			const out = modal.querySelector('[data-seed-out]');
			out.hidden = false;
			if (!Object.values(connectors).some(Boolean)) {
				out.innerHTML = '<span class="mem-seed-fail">No connector returned data. Check the handles or that the connectors are configured.</span>';
				go.disabled = false; go.textContent = 'Fetch & synthesize';
				return;
			}
			go.textContent = 'Synthesizing…';
			try {
				const result = await synthesizeMemorySeed(connectors);
				seedMarkdown = result.memory_seed || '';
				out.textContent = seedMarkdown;
				modal.querySelector('[data-seed-save-tools]').hidden = false;
			} catch (err) {
				out.innerHTML = `<span class="mem-seed-fail">${esc(err.message)}</span>`;
			} finally {
				go.disabled = false; go.textContent = 'Fetch & synthesize';
			}
		});
		modal.querySelector('[data-seed-save]').addEventListener('click', async () => {
			if (!seedMarkdown) return;
			const notice = modal.querySelector('[data-seed-notice]');
			const btn = modal.querySelector('[data-seed-save]');
			btn.disabled = true; notice.textContent = 'Saving…';
			try {
				await saveMemoryToAgent(this.agentId, seedMarkdown, {
					type: 'user', tags: ['identity', 'seed'], salience: 0.95,
					context: { source: 'memory_seed_synthesis', tier: 'working' },
				});
				notice.textContent = 'Saved.';
				this._toast('Identity seeded into working memory');
				modal.remove();
				await this._load();
				this._selectView('timeline');
			} catch (err) {
				notice.textContent = err.message;
				btn.disabled = false;
			}
		});
	}

	// ── Delight: toast + "your agent learned" nudge ──────────────────────────────

	_toast(msg, isError = false) {
		const t = this._q('[data-toast]');
		t.textContent = msg;
		t.hidden = false;
		t.className = `mem-toast ${isError ? 'mem-toast-err' : ''} show`;
		clearTimeout(this._toastTimer);
		this._toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 2600);
	}

	_learned(mem) {
		const title = String(mem.content || '').split('\n')[0].slice(0, 60);
		this._toast(`✦ Your agent learned: “${title}${title.length >= 60 ? '…' : ''}”`);
	}
}
