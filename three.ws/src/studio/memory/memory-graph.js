/**
 * Memory Studio — knowledge graph renderer (P2)
 * =============================================
 * A dependency-free canvas force-directed graph of the agent's memory entities.
 * Nodes are coins/tickers/wallets/people/strategies/topics; edges are
 * co-occurrence within a memory. Click a node to drill into the memories that
 * formed it. Honors prefers-reduced-motion (settles instantly, no idle anim).
 */

const KIND_COLOR = {
	mint: '#8b5cf6',
	ticker: '#22d3ee',
	wallet: '#f59e0b',
	person: '#ec4899',
	strategy: '#4ade80',
	topic: '#94a3b8',
};

const KIND_GLYPH = {
	mint: '◎',
	ticker: '$',
	wallet: '⬡',
	person: '@',
	strategy: '★',
	topic: '#',
};

export class MemoryGraph {
	constructor(canvas, { onSelect } = {}) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.onSelect = onSelect || (() => {});
		this.nodes = [];
		this.edges = [];
		this.selected = null;
		this.hover = null;
		this._raf = null;
		this._alpha = 0;
		this._dpr = Math.min(window.devicePixelRatio || 1, 2);
		this._reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

		this._onResize = () => this._resize();
		window.addEventListener('resize', this._onResize);
		canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
		canvas.addEventListener('pointerleave', () => { this.hover = null; this.canvas.style.cursor = 'default'; });
		canvas.addEventListener('click', (e) => this._onClick(e));
		this._resize();
	}

	destroy() {
		cancelAnimationFrame(this._raf);
		window.removeEventListener('resize', this._onResize);
	}

	_resize() {
		const rect = this.canvas.getBoundingClientRect();
		this.w = Math.max(rect.width, 1);
		this.h = Math.max(rect.height, 1);
		this.canvas.width = this.w * this._dpr;
		this.canvas.height = this.h * this._dpr;
		this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
		this._draw();
	}

	setData({ nodes, edges }) {
		const prev = new Map(this.nodes.map((n) => [n.id, n]));
		const maxMentions = Math.max(1, ...nodes.map((n) => n.mentions || 1));
		this.nodes = nodes.map((n) => {
			const old = prev.get(n.id);
			return {
				...n,
				r: 6 + 10 * Math.sqrt((n.mentions || 1) / maxMentions),
				x: old?.x ?? this.w / 2 + (Math.random() - 0.5) * this.w * 0.6,
				y: old?.y ?? this.h / 2 + (Math.random() - 0.5) * this.h * 0.6,
				vx: 0,
				vy: 0,
			};
		});
		this._index = new Map(this.nodes.map((n) => [n.id, n]));
		this.edges = edges
			.map((e) => ({ ...e, s: this._index.get(e.source), t: this._index.get(e.target) }))
			.filter((e) => e.s && e.t);
		this._alpha = 1;
		this._run();
	}

	_run() {
		cancelAnimationFrame(this._raf);
		const step = () => {
			this._tick();
			this._draw();
			if (this._alpha > 0.01 && !this._reduced) {
				this._raf = requestAnimationFrame(step);
			}
		};
		if (this._reduced) {
			for (let i = 0; i < 220; i++) this._tick(); // settle synchronously
			this._draw();
		} else {
			this._raf = requestAnimationFrame(step);
		}
	}

	_tick() {
		const cx = this.w / 2;
		const cy = this.h / 2;
		const nodes = this.nodes;
		// Repulsion (O(n²) — capped node count keeps this cheap).
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i];
			a.fx = (cx - a.x) * 0.002; // center gravity
			a.fy = (cy - a.y) * 0.002;
			for (let j = 0; j < nodes.length; j++) {
				if (i === j) continue;
				const b = nodes[j];
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let d2 = dx * dx + dy * dy || 0.01;
				const f = 900 / d2;
				a.fx += dx * f;
				a.fy += dy * f;
			}
		}
		// Attraction along edges.
		for (const e of this.edges) {
			const dx = e.t.x - e.s.x;
			const dy = e.t.y - e.s.y;
			const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
			const k = 0.0008 * Math.min(e.weight, 6) * (dist - 90);
			const fx = dx * k;
			const fy = dy * k;
			e.s.fx += fx; e.s.fy += fy;
			e.t.fx -= fx; e.t.fy -= fy;
		}
		const damp = 0.82;
		for (const n of nodes) {
			n.vx = (n.vx + n.fx) * damp;
			n.vy = (n.vy + n.fy) * damp;
			n.x += n.vx * this._alpha;
			n.y += n.vy * this._alpha;
			n.x = Math.max(n.r, Math.min(this.w - n.r, n.x));
			n.y = Math.max(n.r, Math.min(this.h - n.r, n.y));
		}
		this._alpha *= 0.985;
	}

	_draw() {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.w, this.h);
		if (!this.nodes.length) return;

		const sel = this.selected;
		const neighbors = new Set();
		if (sel) {
			for (const e of this.edges) {
				if (e.s.id === sel) neighbors.add(e.t.id);
				if (e.t.id === sel) neighbors.add(e.s.id);
			}
		}

		// Edges.
		for (const e of this.edges) {
			const active = sel && (e.s.id === sel || e.t.id === sel);
			ctx.strokeStyle = active ? 'rgba(139,92,246,0.55)' : 'rgba(255,255,255,0.07)';
			ctx.lineWidth = active ? 1.6 : 0.8;
			ctx.beginPath();
			ctx.moveTo(e.s.x, e.s.y);
			ctx.lineTo(e.t.x, e.t.y);
			ctx.stroke();
		}

		// Nodes.
		for (const n of this.nodes) {
			const dim = sel && n.id !== sel && !neighbors.has(n.id);
			const color = KIND_COLOR[n.kind] || '#94a3b8';
			ctx.globalAlpha = dim ? 0.25 : 1;
			ctx.beginPath();
			ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.fill();
			if (n.id === sel || n.id === this.hover) {
				ctx.lineWidth = 2;
				ctx.strokeStyle = '#fff';
				ctx.stroke();
			}
			// Label for larger / focused nodes.
			if (n.r > 10 || n.id === this.hover || n.id === sel) {
				ctx.globalAlpha = dim ? 0.3 : 0.92;
				ctx.fillStyle = '#fff';
				ctx.font = '11px Inter, system-ui, sans-serif';
				ctx.textAlign = 'center';
				const label = n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label;
				ctx.fillText(label, n.x, n.y + n.r + 12);
			}
			ctx.globalAlpha = 1;
		}
	}

	_nodeAt(x, y) {
		// Topmost (last drawn) wins.
		for (let i = this.nodes.length - 1; i >= 0; i--) {
			const n = this.nodes[i];
			const dx = x - n.x;
			const dy = y - n.y;
			if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return n;
		}
		return null;
	}

	_localPoint(e) {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	_onPointerMove(e) {
		const { x, y } = this._localPoint(e);
		const n = this._nodeAt(x, y);
		const id = n?.id || null;
		if (id !== this.hover) {
			this.hover = id;
			this.canvas.style.cursor = id ? 'pointer' : 'default';
			if (this._alpha <= 0.01) this._draw();
		}
	}

	_onClick(e) {
		const { x, y } = this._localPoint(e);
		const n = this._nodeAt(x, y);
		this.select(n ? n.id : null);
		this.onSelect(n || null);
	}

	select(id) {
		this.selected = id;
		this._draw();
	}

	static color(kind) { return KIND_COLOR[kind] || '#94a3b8'; }
	static glyph(kind) { return KIND_GLYPH[kind] || '#'; }
}
