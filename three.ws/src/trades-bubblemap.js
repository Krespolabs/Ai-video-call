/**
 * Holder bubblemap — a dependency-free canvas force simulation of a coin's
 * wallet footprint. Every node is a real trading wallet from
 * /api/pump/intel (the `wallets` array); radius is proportional to the wallet's
 * share of buy volume, colour encodes its behavioural label, and wallets that
 * share an on-chain funder (the `cluster`/`funder` fields) are pulled together
 * and wired with faint links — the same coordination signal that drives the
 * conviction score, made visible.
 *
 * No fabricated nodes: if a coin has no enriched wallet set, the caller renders
 * the empty state instead of mounting this. The sim is a light Verlet-ish
 * spring/repulsion loop that settles in ~2s and then idles cheaply.
 */

import { shortAddr } from './trader-format.js';

// Behavioural label → colour. Mirrors the palette the rest of the terminal uses
// so a "whale" reads the same amber everywhere. Order matters: the first label a
// wallet carries from this list wins as its primary colour.
const LABEL_STYLE = [
	['creator',     { color: '#c084fc', ring: 'rgba(192,132,252,.5)',  name: 'Creator' }],
	['rugger',      { color: '#f43f5e', ring: 'rgba(244,63,94,.5)',    name: 'Rugger' }],
	['dumped',      { color: '#f87171', ring: 'rgba(248,113,113,.5)',  name: 'Dumped' }],
	['sniper',      { color: '#fb923c', ring: 'rgba(251,146,60,.5)',   name: 'Sniper' }],
	['bundled',     { color: '#fbbf24', ring: 'rgba(251,191,36,.5)',   name: 'Bundled' }],
	['smart_money', { color: '#34d399', ring: 'rgba(52,211,153,.5)',   name: 'Smart money' }],
	['whale',       { color: '#22d3ee', ring: 'rgba(34,211,238,.5)',   name: 'Whale' }],
	['holding',     { color: '#60a5fa', ring: 'rgba(96,165,250,.5)',   name: 'Holding' }],
	['flipped',     { color: '#94a3b8', ring: 'rgba(148,163,184,.5)',  name: 'Flipped' }],
];
const DEFAULT_STYLE = { color: '#64748b', ring: 'rgba(100,116,139,.4)', name: 'Trader' };

function styleFor(labels) {
	const set = new Set(Array.isArray(labels) ? labels : []);
	for (const [key, style] of LABEL_STYLE) if (set.has(key)) return { key, ...style };
	return { key: 'trader', ...DEFAULT_STYLE };
}

// Distinct legend entries actually present in this wallet set, in palette order.
function legendFor(nodes) {
	const seen = new Map();
	for (const n of nodes) if (!seen.has(n.style.key)) seen.set(n.style.key, n.style);
	return [...seen.values()];
}

/**
 * @param {HTMLElement} host     — container; sized via CSS, the canvas fills it.
 * @param {object} opts
 * @param {Array}  opts.wallets  — /api/pump/intel `wallets[]`
 * @param {Array}  [opts.clusters] — /api/pump/intel `clusters[]` (for link weight)
 * @param {(wallet:object)=>void} [opts.onSelect] — click a bubble
 * @returns {{ destroy(): void }}
 */
export function mountBubblemap(host, opts = {}) {
	const wallets = (Array.isArray(opts.wallets) ? opts.wallets : [])
		.filter((w) => w && w.wallet && Number(w.buy_sol) > 0)
		.sort((a, b) => Number(b.buy_sol) - Number(a.buy_sol))
		.slice(0, 80); // cap for legibility + perf; these are the wallets that matter

	if (!wallets.length) {
		host.innerHTML = `<div class="bm-empty">No enriched wallet graph for this coin yet.<br>The funder map appears once first-buyer wallets are traced on-chain.</div>`;
		return { destroy() { host.innerHTML = ''; } };
	}

	const maxBuy = Math.max(...wallets.map((w) => Number(w.buy_sol) || 0)) || 1;
	const totalBuy = wallets.reduce((s, w) => s + (Number(w.buy_sol) || 0), 0) || 1;

	host.innerHTML = `
		<canvas class="bm-canvas" aria-label="Holder funder bubblemap"></canvas>
		<div class="bm-tip" hidden></div>
		<div class="bm-legend"></div>`;
	const canvas = host.querySelector('.bm-canvas');
	const tip = host.querySelector('.bm-tip');
	const legendEl = host.querySelector('.bm-legend');
	const ctx = canvas.getContext('2d');

	let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);

	// Build nodes. Radius ∝ sqrt(share) so area tracks volume share, not linear.
	const nodes = wallets.map((w) => {
		const buy = Number(w.buy_sol) || 0;
		const share = buy / totalBuy;
		const r = 7 + Math.sqrt(buy / maxBuy) * 30;
		return {
			w,
			label: shortAddr(w.wallet, 4, 4),
			style: styleFor(w.labels),
			cluster: w.cluster ?? w.funder ?? null,
			share,
			r,
			x: 0, y: 0, vx: 0, vy: 0,
		};
	});

	// Group node indices by cluster so members spring toward a shared centroid.
	const clusterMembers = new Map();
	for (let i = 0; i < nodes.length; i++) {
		const c = nodes[i].cluster;
		if (c == null) continue;
		if (!clusterMembers.has(c)) clusterMembers.set(c, []);
		clusterMembers.get(c).push(i);
	}
	// Links only within clusters of 2+ wallets — that's the coordination story.
	const links = [];
	for (const idxs of clusterMembers.values()) {
		if (idxs.length < 2) continue;
		for (let a = 0; a < idxs.length; a++)
			for (let b = a + 1; b < Math.min(idxs.length, a + 4); b++)
				links.push([idxs[a], idxs[b]]);
	}

	legendEl.innerHTML = legendFor(nodes)
		.map((s) => `<span class="bm-leg"><i style="background:${s.color}"></i>${s.name}</span>`)
		.join('');

	function resize() {
		const rect = host.getBoundingClientRect();
		W = Math.max(240, rect.width);
		H = Math.max(220, rect.height);
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.round(W * dpr);
		canvas.height = Math.round(H * dpr);
		canvas.style.width = `${W}px`;
		canvas.style.height = `${H}px`;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	// Seed positions: scatter on a ring, biggest wallets toward the centre.
	function seed() {
		const cx = W / 2, cy = H / 2;
		nodes.forEach((n, i) => {
			const ang = (i / nodes.length) * Math.PI * 2 + (i % 3);
			const rad = (0.2 + (1 - n.r / 40) * 0.5) * Math.min(W, H) * 0.4;
			n.x = cx + Math.cos(ang) * rad + (i % 7 - 3);
			n.y = cy + Math.sin(ang) * rad + (i % 5 - 2);
			n.vx = n.vy = 0;
		});
	}

	// One physics step: centre gravity, pairwise repulsion, cluster cohesion,
	// link springs, wall bounce. Cheap O(n²) — n ≤ 80.
	function step(alpha) {
		const cx = W / 2, cy = H / 2;
		// cluster centroids
		const centroids = new Map();
		for (const [c, idxs] of clusterMembers) {
			let sx = 0, sy = 0;
			for (const i of idxs) { sx += nodes[i].x; sy += nodes[i].y; }
			centroids.set(c, { x: sx / idxs.length, y: sy / idxs.length });
		}
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			// gentle pull to centre
			n.vx += (cx - n.x) * 0.0009 * alpha;
			n.vy += (cy - n.y) * 0.0009 * alpha;
			// cluster cohesion
			if (n.cluster != null && centroids.has(n.cluster)) {
				const c = centroids.get(n.cluster);
				n.vx += (c.x - n.x) * 0.01 * alpha;
				n.vy += (c.y - n.y) * 0.01 * alpha;
			}
			// repulsion
			for (let j = i + 1; j < nodes.length; j++) {
				const m = nodes[j];
				let dx = n.x - m.x, dy = n.y - m.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 0.01) { dx = (i - j) * 0.5 + 0.1; dy = 0.1; d2 = dx * dx + dy * dy; }
				const minD = n.r + m.r + 6;
				const d = Math.sqrt(d2);
				const force = (minD * minD) / d2;
				const push = Math.min(force, 14) * alpha * 0.5;
				const ux = dx / d, uy = dy / d;
				n.vx += ux * push; n.vy += uy * push;
				m.vx -= ux * push; m.vy -= uy * push;
			}
		}
		// link springs hold same-funder wallets near each other
		for (const [a, b] of links) {
			const n = nodes[a], m = nodes[b];
			const dx = m.x - n.x, dy = m.y - n.y;
			const d = Math.hypot(dx, dy) || 1;
			const rest = n.r + m.r + 18;
			const f = (d - rest) * 0.012 * alpha;
			const ux = dx / d, uy = dy / d;
			n.vx += ux * f; n.vy += uy * f;
			m.vx -= ux * f; m.vy -= uy * f;
		}
		// integrate + damping + walls
		for (const n of nodes) {
			n.vx *= 0.86; n.vy *= 0.86;
			n.x += n.vx; n.y += n.vy;
			if (n.x < n.r) { n.x = n.r; n.vx *= -0.4; }
			if (n.x > W - n.r) { n.x = W - n.r; n.vx *= -0.4; }
			if (n.y < n.r) { n.y = n.r; n.vy *= -0.4; }
			if (n.y > H - n.r) { n.y = H - n.r; n.vy *= -0.4; }
		}
	}

	let hovered = null;

	function draw() {
		ctx.clearRect(0, 0, W, H);
		// links
		ctx.lineWidth = 1;
		for (const [a, b] of links) {
			const n = nodes[a], m = nodes[b];
			ctx.strokeStyle = 'rgba(251,191,36,.10)';
			ctx.beginPath();
			ctx.moveTo(n.x, n.y);
			ctx.lineTo(m.x, m.y);
			ctx.stroke();
		}
		// bubbles
		for (const n of nodes) {
			const isHover = n === hovered;
			ctx.beginPath();
			ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
			ctx.fillStyle = n.style.color + (isHover ? '40' : '26');
			ctx.fill();
			ctx.lineWidth = isHover ? 2 : 1.25;
			ctx.strokeStyle = isHover ? n.style.color : n.style.ring;
			ctx.stroke();
			// label only on bubbles large enough to hold it
			if (n.r >= 16) {
				ctx.fillStyle = 'rgba(255,255,255,.82)';
				ctx.font = '600 9px ui-monospace, monospace';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(n.label, n.x, n.y);
			}
		}
	}

	// ── animation loop ───────────────────────────────────────────────────────────
	let raf = 0, frame = 0, running = true;
	function loop() {
		if (!running) return;
		// high alpha early for fast settle, then a low idle alpha to stay lively
		const alpha = frame < 120 ? 1 : 0.18;
		step(alpha);
		draw();
		frame++;
		raf = requestAnimationFrame(loop);
	}

	// ── pointer: hover tooltip + click select ────────────────────────────────────
	function nodeAt(px, py) {
		for (let i = nodes.length - 1; i >= 0; i--) {
			const n = nodes[i];
			if ((px - n.x) ** 2 + (py - n.y) ** 2 <= n.r * n.r) return n;
		}
		return null;
	}
	function onMove(e) {
		const rect = canvas.getBoundingClientRect();
		const px = e.clientX - rect.left, py = e.clientY - rect.top;
		const n = nodeAt(px, py);
		hovered = n;
		canvas.style.cursor = n ? 'pointer' : 'default';
		if (!n) { tip.hidden = true; return; }
		const w = n.w;
		const pct = (n.share * 100).toFixed(n.share >= 0.1 ? 0 : 1);
		tip.innerHTML = `
			<div class="bm-tip-addr">${shortAddr(w.wallet, 6, 6)} <b>${n.style.name}</b></div>
			<div class="bm-tip-row"><span>Buy</span><b>${(Number(w.buy_sol) || 0).toFixed(2)} ◎</b></div>
			<div class="bm-tip-row"><span>Sell</span><b>${(Number(w.sell_sol) || 0).toFixed(2)} ◎</b></div>
			<div class="bm-tip-row"><span>Share of buys</span><b>${pct}%</b></div>
			${w.funder ? `<div class="bm-tip-row"><span>Funder</span><b>${shortAddr(w.funder, 4, 4)}</b></div>` : ''}`;
		tip.hidden = false;
		const tx = Math.min(px + 14, W - 170);
		const ty = Math.min(py + 14, H - 90);
		tip.style.left = `${Math.max(6, tx)}px`;
		tip.style.top = `${Math.max(6, ty)}px`;
	}
	function onLeave() { hovered = null; tip.hidden = true; }
	function onClick(e) {
		const rect = canvas.getBoundingClientRect();
		const n = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
		if (n && typeof opts.onSelect === 'function') opts.onSelect(n.w);
	}

	canvas.addEventListener('mousemove', onMove);
	canvas.addEventListener('mouseleave', onLeave);
	canvas.addEventListener('click', onClick);

	const ro = new ResizeObserver(() => {
		const prevW = W;
		resize();
		if (!prevW) { seed(); frame = 0; }
	});
	ro.observe(host);

	resize();
	seed();
	loop();

	return {
		destroy() {
			running = false;
			cancelAnimationFrame(raf);
			try { ro.disconnect(); } catch { /* gone */ }
			canvas.removeEventListener('mousemove', onMove);
			canvas.removeEventListener('mouseleave', onLeave);
			canvas.removeEventListener('click', onClick);
			host.innerHTML = '';
		},
	};
}
