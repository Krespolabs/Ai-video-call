// Agent Memory Graph — the living knowledge graph rendered in the agent's Diary.
// =============================================================================
// Two layers, intentionally split so the math is testable without a DOM:
//
//   1. PURE functions (rankByMentions, layoutGraph, shapeDigestEntities,
//      digestCounts, entityHref) — deterministic, no canvas, no randomness.
//      These shape the real memory graph (api/memory/graph) and the day's
//      memories into the digest the API returns and the renderer draws. Unit
//      tested in tests/agent-memory-graph.test.js.
//
//   2. AgentMemoryGraph — a small 2D canvas renderer that lays those nodes out
//      radially (brightest = most-mentioned, centred), draws co-occurrence
//      edges, and exposes light(nodeId) so the Diary can pulse a node as its
//      name is spoken. Instantiated only in the browser; importing this module
//      in Node (tests, the API endpoint) never touches the canvas.
//
// Nothing here invents data: every node/edge originates from the agent's real
// mined entity graph; the layout only positions what it is given.

// Entity kinds the memory miner emits (api/_lib/memory-entities.js).
export const ENTITY_KINDS = ['mint', 'ticker', 'wallet', 'person', 'strategy', 'topic'];

// Colour per entity kind — coins/mints glow $THREE-gold, people cyan, the rest
// cool neutrals so the graph reads at a glance.
export const KIND_COLORS = {
	mint: [255, 196, 0],
	ticker: [255, 196, 0],
	person: [56, 224, 201],
	wallet: [149, 168, 255],
	strategy: [196, 149, 255],
	topic: [148, 163, 184],
	agent: [56, 224, 201],
};

function clamp(n, lo, hi) {
	if (!Number.isFinite(n)) return lo;
	return Math.max(lo, Math.min(hi, n));
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Rank entity nodes by how often the agent's memories mention them (mentions
 * desc, then salience, then a stable label tiebreak so the order is
 * deterministic across renders and test runs).
 */
export function rankByMentions(nodes = []) {
	return [...(nodes || [])]
		.filter((n) => n && n.id)
		.sort((a, b) => {
			const dm = (b.mentions || 0) - (a.mentions || 0);
			if (dm) return dm;
			const ds = (b.salience || 0) - (a.salience || 0);
			if (ds) return ds;
			return String(a.label || '').localeCompare(String(b.label || ''));
		});
}

// ── Link mapping ───────────────────────────────────────────────────────────

/**
 * Map one entity node to a navigable href, or null when it isn't addressable.
 *   • mint  → /launches/<address>            (the coin's addressable profile)
 *   • person/agent → /agent-screen?agentId=  (when resolved to a real agent)
 * `agentIndex` is an optional Map of lowercased agent name → agentId, built by
 * the API from real agent_identities rows; without a match a person is just a
 * chip. Never fabricates a destination.
 */
export function entityHref(node, agentIndex = null) {
	if (!node) return null;
	const kind = node.kind;
	if (kind === 'mint') {
		// The mint address is the normalized form; fall back to label.
		const mint = String(node.normalized || node.label || '').trim();
		if (mint) return `/launches/${encodeURIComponent(mint)}`;
		return null;
	}
	if ((kind === 'person' || kind === 'agent') && agentIndex) {
		const key = String(node.label || '').trim().toLowerCase();
		const agentId = key && agentIndex.get ? agentIndex.get(key) : (agentIndex[key] || null);
		if (agentId) return `/agent-screen?agentId=${encodeURIComponent(agentId)}`;
	}
	return null;
}

/**
 * Shape the raw graph nodes into the top-N entity chips the Diary renders:
 * ranked by mentions, deduped by id, capped, each carrying a resolved href when
 * one exists. Pure — `agentIndex` supplies the only external knowledge.
 */
export function shapeDigestEntities(nodes = [], { topN = 12, agentIndex = null } = {}) {
	const ranked = rankByMentions(nodes);
	const seen = new Set();
	const out = [];
	for (const n of ranked) {
		if (seen.has(n.id)) continue;
		seen.add(n.id);
		out.push({
			id: n.id,
			kind: ENTITY_KINDS.includes(n.kind) ? n.kind : (n.kind || 'topic'),
			label: String(n.label || '').slice(0, 80),
			mentions: n.mentions || 0,
			salience: n.salience ?? null,
			href: entityHref(n, agentIndex),
		});
		if (out.length >= topN) break;
	}
	return out;
}

/**
 * Derive the day's headline counts strictly from the real memory rows:
 *   • learned     — memories formed in the window
 *   • decided     — memories tagged a decision (tag "decision" or context.kind)
 *   • interacted  — distinct people/agents the memories mention
 * Honest by construction: a count is 0 when the rows don't support it.
 */
export function digestCounts(memories = [], entities = []) {
	const mem = Array.isArray(memories) ? memories : [];
	const ents = Array.isArray(entities) ? entities : [];
	const decided = mem.filter((m) => {
		const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t).toLowerCase()) : [];
		if (tags.includes('decision') || tags.includes('decided')) return true;
		const ctxKind = m.context && typeof m.context === 'object' ? String(m.context.kind || '').toLowerCase() : '';
		return ctxKind === 'decision';
	}).length;
	const interacted = ents.filter((e) => e.kind === 'person' || e.kind === 'agent').length;
	return { learned: mem.length, decided, interacted };
}

// ── Layout (radial, deterministic) ───────────────────────────────────────────

/**
 * Lay out ranked nodes radially: the most-mentioned node anchors the centre,
 * the rest fan out on concentric rings (closer + larger + brighter = more
 * mentions). Deterministic — angle derives from the node's index, never random
 * — so the same graph always renders the same way (and the tests can assert it).
 *
 * @returns {Array<{id,label,kind,mentions,x,y,r,brightness}>}
 */
export function layoutGraph(nodes = [], edges = [], { width = 320, height = 220, maxNodes = 40, padding = 24 } = {}) {
	const ranked = rankByMentions(nodes).slice(0, maxNodes);
	if (!ranked.length) return [];

	const cx = width / 2;
	const cy = height / 2;
	const maxR = Math.max(8, Math.min(width, height) / 2 - padding);
	const maxMentions = Math.max(1, ranked[0].mentions || 1);

	// Ring assignment: node 0 → centre; then 5 per ring expanding outward.
	const PER_RING = 6;
	return ranked.map((n, i) => {
		const mentions = n.mentions || 0;
		// Node radius (visual size) scales with mention share, 4–13px.
		const share = mentions / maxMentions;
		const r = 4 + share * 9;
		// Brightness 0.35–1: brightest = most-mentioned.
		const brightness = clamp(0.35 + share * 0.65, 0.35, 1);

		let x = cx;
		let y = cy;
		if (i > 0) {
			const ring = Math.ceil(i / PER_RING);
			const ringRadius = (maxR * ring) / (Math.ceil((ranked.length - 1) / PER_RING) || 1);
			const idxInRing = (i - 1) % PER_RING;
			const countInRing = Math.min(PER_RING, ranked.length - 1 - (ring - 1) * PER_RING);
			// Offset alternate rings by half a slot so nodes don't line up radially.
			const angle = (idxInRing / Math.max(1, countInRing)) * Math.PI * 2 + (ring % 2 ? 0 : Math.PI / PER_RING);
			x = cx + Math.cos(angle) * ringRadius;
			y = cy + Math.sin(angle) * ringRadius;
		}
		return {
			id: n.id,
			label: String(n.label || ''),
			kind: n.kind || 'topic',
			mentions,
			x: clamp(x, padding, width - padding),
			y: clamp(y, padding, height - padding),
			r,
			brightness,
		};
	});
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

/**
 * AgentMemoryGraph — draws a laid-out memory graph into a <canvas> and pulses
 * nodes on demand. All visual state is recomputed from setData() + the layout
 * helper above; no data is invented here.
 */
export class AgentMemoryGraph {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {{ onNodeClick?:(node:object)=>void }} [opts]
	 */
	constructor(canvas, { onNodeClick = null } = {}) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.onNodeClick = onNodeClick;
		this._nodes = [];
		this._edges = [];
		this._positions = [];
		this._byId = new Map();
		this._pulses = new Map(); // id → pulse phase 0..1 (1 = just lit)
		this._raf = null;
		this._dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
		this._w = 0;
		this._h = 0;

		this._onClick = (e) => this._handleClick(e);
		this._onMove = (e) => this._handleMove(e);
		canvas.addEventListener('click', this._onClick);
		canvas.addEventListener('pointermove', this._onMove);
	}

	/** Match the backing store to the element's CSS box. */
	resize() {
		const rect = this.canvas.getBoundingClientRect();
		const w = Math.max(1, Math.round(rect.width));
		const h = Math.max(1, Math.round(rect.height));
		this._dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
		this.canvas.width = Math.round(w * this._dpr);
		this.canvas.height = Math.round(h * this._dpr);
		this._w = w;
		this._h = h;
		this._relayout();
	}

	/** Replace the graph data and recompute the layout. */
	setData({ nodes = [], edges = [] } = {}) {
		this._nodes = nodes || [];
		this._edges = edges || [];
		this._relayout();
	}

	_relayout() {
		if (!this._w || !this._h) {
			const rect = this.canvas.getBoundingClientRect();
			this._w = Math.max(1, Math.round(rect.width));
			this._h = Math.max(1, Math.round(rect.height));
		}
		this._positions = layoutGraph(this._nodes, this._edges, { width: this._w, height: this._h });
		this._byId = new Map(this._positions.map((p) => [p.id, p]));
	}

	/** Pulse a node by id (brighten + ring), e.g. as its name is spoken. */
	light(nodeId) {
		if (this._byId.has(nodeId)) this._pulses.set(nodeId, 1);
	}

	/** Pulse the highest-mention node matching a label fragment (speech sync). */
	lightByLabel(fragment) {
		const f = String(fragment || '').trim().toLowerCase();
		if (!f) return;
		for (const p of this._positions) {
			if (p.label && f.includes(p.label.toLowerCase())) { this.light(p.id); return; }
		}
	}

	start() {
		if (this._raf != null) return;
		const tick = () => {
			this._raf = requestAnimationFrame(tick);
			this._draw();
		};
		this._raf = requestAnimationFrame(tick);
	}

	stop() {
		if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
	}

	dispose() {
		this.stop();
		this.canvas.removeEventListener('click', this._onClick);
		this.canvas.removeEventListener('pointermove', this._onMove);
		this._pulses.clear();
		this._byId.clear();
	}

	_nodeAt(clientX, clientY) {
		const rect = this.canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		let best = null;
		let bestD = Infinity;
		for (const p of this._positions) {
			const d = Math.hypot(p.x - x, p.y - y);
			if (d <= Math.max(10, p.r + 6) && d < bestD) { best = p; bestD = d; }
		}
		return best;
	}

	_handleClick(e) {
		const node = this._nodeAt(e.clientX, e.clientY);
		if (node && this.onNodeClick) this.onNodeClick(node);
	}

	_handleMove(e) {
		const node = this._nodeAt(e.clientX, e.clientY);
		this.canvas.style.cursor = node ? 'pointer' : 'default';
	}

	_draw() {
		const ctx = this.ctx;
		if (!ctx) return;
		const dpr = this._dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this._w, this._h);

		if (!this._positions.length) return;

		// Edges first (under nodes).
		ctx.lineWidth = 1;
		for (const e of this._edges) {
			const a = this._byId.get(e.source);
			const b = this._byId.get(e.target);
			if (!a || !b) continue;
			const w = clamp((e.weight || 1) / 4, 0.06, 0.5);
			ctx.strokeStyle = `rgba(148,163,184,${w})`;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}

		// Nodes.
		for (const p of this._positions) {
			let pulse = this._pulses.get(p.id) || 0;
			if (pulse > 0) {
				pulse = Math.max(0, pulse - 0.02);
				if (pulse === 0) this._pulses.delete(p.id);
				else this._pulses.set(p.id, pulse);
			}
			const [r, g, b] = KIND_COLORS[p.kind] || KIND_COLORS.topic;
			const baseAlpha = p.brightness;
			const alpha = clamp(baseAlpha + pulse * 0.4, 0, 1);
			const radius = p.r + pulse * 6;

			// Glow halo (stronger while pulsing).
			const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 3.2);
			glow.addColorStop(0, `rgba(${r},${g},${b},${0.32 * alpha})`);
			glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
			ctx.fillStyle = glow;
			ctx.beginPath();
			ctx.arc(p.x, p.y, radius * 3.2, 0, Math.PI * 2);
			ctx.fill();

			// Core dot.
			ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
			ctx.beginPath();
			ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
			ctx.fill();

			// Pulse ring.
			if (pulse > 0) {
				ctx.strokeStyle = `rgba(${r},${g},${b},${pulse * 0.6})`;
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(p.x, p.y, radius + (1 - pulse) * 12, 0, Math.PI * 2);
				ctx.stroke();
			}

			// Label for the brightest handful only (avoid clutter).
			if (p.brightness > 0.62 && p.label) {
				ctx.font = '10px ui-monospace, monospace';
				ctx.fillStyle = `rgba(228,228,231,${clamp(alpha + 0.15, 0, 0.92)})`;
				ctx.textAlign = 'center';
				ctx.fillText(truncateLabel(p.label, 16), p.x, p.y - radius - 5);
			}
		}
	}
}

function truncateLabel(s, n) {
	const str = String(s || '');
	return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
