// /heatmap — a live market treemap adopted from the cryptocurrency.cv heatmap:
// every top coin is a tile sized by market cap and colored by its price move.
// Data is the real /api/coin/markets feed (same source as /coins) — the layout
// is a squarified treemap computed client-side. No mock data.

import { formatUsd, formatPrice, formatPercent, escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

const state = { coins: [], key: 'change_24h', count: 50, loading: true };

// ── Squarified treemap (Bruls, Huizing & van Wijk) ────────────────────────────

function squarify(nodes, width, height) {
	const total = nodes.reduce((s, n) => s + n.value, 0) || 1;
	const scale = (width * height) / total;
	const items = nodes.map((n) => ({ node: n, area: n.value * scale }));
	const out = [];
	let rect = { x: 0, y: 0, w: width, h: height };
	let row = [];

	const worst = (r, shorter) => {
		if (!r.length) return Infinity;
		const sum = r.reduce((a, b) => a + b.area, 0);
		const max = Math.max(...r.map((x) => x.area));
		const min = Math.min(...r.map((x) => x.area));
		const s2 = sum * sum;
		const w2 = shorter * shorter;
		return Math.max((w2 * max) / s2, s2 / (w2 * min));
	};

	const layoutRow = (r) => {
		const sum = r.reduce((a, b) => a + b.area, 0);
		const horizontal = rect.w >= rect.h;
		if (horizontal) {
			const colW = sum / rect.h;
			let y = rect.y;
			for (const it of r) {
				const cellH = it.area / colW;
				out.push({ node: it.node, x: rect.x, y, w: colW, h: cellH });
				y += cellH;
			}
			rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
		} else {
			const rowH = sum / rect.w;
			let x = rect.x;
			for (const it of r) {
				const cellW = it.area / rowH;
				out.push({ node: it.node, x, y: rect.y, w: cellW, h: rowH });
				x += cellW;
			}
			rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
		}
	};

	let i = 0;
	while (i < items.length) {
		const next = items[i];
		const shorter = Math.min(rect.w, rect.h);
		if (row.length === 0 || worst(row, shorter) >= worst([...row, next], shorter)) {
			row.push(next);
			i++;
		} else {
			layoutRow(row);
			row = [];
		}
	}
	if (row.length) layoutRow(row);
	return out;
}

// ── Color ─────────────────────────────────────────────────────────────────────

const NEUTRAL = [82, 82, 91];
const UP = [22, 163, 74];
const DOWN = [220, 38, 38];

function lerp(a, b, t) {
	return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

function colorFor(pct) {
	if (pct == null || !Number.isFinite(pct)) return `rgb(${NEUTRAL.join(',')})`;
	const t = Math.min(1, Math.abs(pct) / 10); // full saturation at ±10%
	const c = lerp(NEUTRAL, pct >= 0 ? UP : DOWN, t);
	return `rgb(${c.join(',')})`;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
	const el = $('hm-grid');
	if (state.loading) {
		el.innerHTML =
			'<div class="cv-skel" style="position:absolute;inset:0;border-radius:inherit"></div>';
		return;
	}
	const coins = state.coins
		.filter((c) => Number.isFinite(c.market_cap) && c.market_cap > 0)
		.slice(0, state.count);
	if (!coins.length) {
		el.innerHTML =
			'<div class="cv-empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border:0">Market data is temporarily unavailable. Please try again shortly.</div>';
		return;
	}

	const W = el.clientWidth || 900;
	const H = el.clientHeight || 560;
	const nodes = coins.map((c) => ({ value: c.market_cap, coin: c }));
	const tiles = squarify(nodes, W, H);

	el.innerHTML = tiles
		.map(({ node, x, y, w, h }) => {
			const c = node.coin;
			const pct = c[state.key];
			const bg = colorFor(pct);
			const symFont = Math.max(8, Math.min(34, Math.min(w, h) / 4.2));
			const tiny = Math.min(w, h) < 34;
			const href = `/coin/${encodeURIComponent(c.id)}`;
			return `<a class="hm-tile${tiny ? ' tiny' : ''}" href="${esc(href)}"
				style="left:${x.toFixed(2)}px;top:${y.toFixed(2)}px;width:${w.toFixed(2)}px;height:${h.toFixed(2)}px;background:${bg}"
				data-id="${esc(c.id)}"
				aria-label="${esc(c.name)} ${esc(formatPercent(pct))}">
				<span class="sym" style="font-size:${symFont.toFixed(1)}px">${esc(c.symbol)}</span>
				<span class="chg" style="font-size:${(symFont * 0.5).toFixed(1)}px">${esc(formatPercent(pct))}</span>
			</a>`;
		})
		.join('');

	wireTooltip(coins);
}

let tipEl = null;
function wireTooltip(coins) {
	const el = $('hm-grid');
	const byId = new Map(coins.map((c) => [c.id, c]));
	if (!tipEl) {
		tipEl = document.createElement('div');
		tipEl.className = 'hm-tip';
		tipEl.hidden = true;
		document.body.appendChild(tipEl);
	}
	const move = (e) => {
		const tile = e.target.closest('.hm-tile');
		if (!tile) {
			tipEl.hidden = true;
			return;
		}
		const c = byId.get(tile.dataset.id);
		if (!c) return;
		tipEl.innerHTML = `
			<p class="t">${esc(c.name)} <span style="color:var(--cv-text-3)">${esc(c.symbol)}</span></p>
			<p class="r"><span>Price</span><span>${esc(formatPrice(c.price))}</span></p>
			<p class="r"><span>24h</span><span class="${(c.change_24h ?? 0) >= 0 ? 'cv-up' : 'cv-down'}">${esc(formatPercent(c.change_24h))}</span></p>
			<p class="r"><span>7d</span><span class="${(c.change_7d ?? 0) >= 0 ? 'cv-up' : 'cv-down'}">${esc(formatPercent(c.change_7d))}</span></p>
			<p class="r"><span>Mkt Cap</span><span>${esc(formatUsd(c.market_cap))}</span></p>`;
		tipEl.hidden = false;
		const pad = 14;
		let left = e.clientX + pad;
		let top = e.clientY + pad;
		const r = tipEl.getBoundingClientRect();
		if (left + r.width > window.innerWidth - 8) left = e.clientX - r.width - pad;
		if (top + r.height > window.innerHeight - 8) top = e.clientY - r.height - pad;
		tipEl.style.left = `${Math.max(8, left)}px`;
		tipEl.style.top = `${Math.max(8, top)}px`;
	};
	el.onpointermove = move;
	el.onpointerleave = () => {
		tipEl.hidden = true;
	};
}

// ── Controls + boot ───────────────────────────────────────────────────────────

function wireControls() {
	$('hm-timeframe').addEventListener('click', (e) => {
		const btn = e.target.closest('button');
		if (!btn) return;
		state.key = btn.dataset.key;
		$('hm-timeframe')
			.querySelectorAll('button')
			.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
		render();
	});
	$('hm-count').addEventListener('click', async (e) => {
		const btn = e.target.closest('button');
		if (!btn) return;
		state.count = Number(btn.dataset.count);
		$('hm-count')
			.querySelectorAll('button')
			.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
		if (state.count > state.coins.length) await ensureCoins(state.count);
		render();
	});

	let raf = null;
	window.addEventListener('resize', () => {
		if (raf) cancelAnimationFrame(raf);
		raf = requestAnimationFrame(render);
	});
}

async function ensureCoins(min) {
	// /coins markets returns 100 max per page — top 100 covers both count options.
	if (state.coins.length >= min) return;
	try {
		const { coins } = await getJson('/api/coin/markets?page=1&per_page=100');
		state.coins = coins;
	} catch {
		/* keep what we have */
	}
}

async function init() {
	wireControls();
	render(); // skeleton
	await ensureCoins(100);
	state.loading = false;
	render();
	$('hm-updated').textContent = state.coins.length
		? `Sized by market cap · colored by price move · live from CoinGecko`
		: '';
}

init();
