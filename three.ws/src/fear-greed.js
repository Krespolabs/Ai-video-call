// /fear-greed — the Crypto Fear & Greed Index, adopted from the
// cryptocurrency.cv sentiment surface: a live semicircle gauge with the current
// reading, a "vs last week" delta, an interactive historical chart, and a
// labelled scale. Data is the alternative.me index via /api/coin/fear-greed —
// real and cached, never mocked.

import { formatChartTick, formatDateShort, escapeHtml as esc } from './shared/coin-format.js';

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

// Five sentiment bands, low→high. Colors read on both themes.
const BANDS = [
	{ min: 0, max: 25, label: 'Extreme Fear', color: '#ef4444' },
	{ min: 25, max: 45, label: 'Fear', color: '#f97316' },
	{ min: 45, max: 55, label: 'Neutral', color: '#eab308' },
	{ min: 55, max: 75, label: 'Greed', color: '#84cc16' },
	{ min: 75, max: 100, label: 'Extreme Greed', color: '#22c55e' },
];

function bandFor(v) {
	return BANDS.find((b) => v >= b.min && v <= b.max) || BANDS[Math.min(BANDS.length - 1, 0)];
}

// ── Gauge ─────────────────────────────────────────────────────────────────────
// A 180° arc from 0 (left) to 100 (right); the value maps to an angle and the
// needle points at it. Arc is drawn as five colored band segments.

function polar(cx, cy, r, deg) {
	const rad = (deg * Math.PI) / 180;
	return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// value 0→100 maps to angle 180°→360° (left→right across the top semicircle).
function valueAngle(v) {
	return 180 + (Math.max(0, Math.min(100, v)) / 100) * 180;
}

function arcPath(cx, cy, r, startVal, endVal, width) {
	const a0 = valueAngle(startVal);
	const a1 = valueAngle(endVal);
	const outer0 = polar(cx, cy, r, a0);
	const outer1 = polar(cx, cy, r, a1);
	const inner1 = polar(cx, cy, r - width, a1);
	const inner0 = polar(cx, cy, r - width, a0);
	const large = a1 - a0 > 180 ? 1 : 0;
	return (
		`M ${outer0.x.toFixed(2)} ${outer0.y.toFixed(2)} ` +
		`A ${r} ${r} 0 ${large} 1 ${outer1.x.toFixed(2)} ${outer1.y.toFixed(2)} ` +
		`L ${inner1.x.toFixed(2)} ${inner1.y.toFixed(2)} ` +
		`A ${r - width} ${r - width} 0 ${large} 0 ${inner0.x.toFixed(2)} ${inner0.y.toFixed(2)} Z`
	);
}

function gaugeSvg(value) {
	const W = 320;
	const H = 190;
	const cx = W / 2;
	const cy = 170;
	const r = 140;
	const width = 26;
	const segs = BANDS.map(
		(b) =>
			`<path d="${arcPath(cx, cy, r, b.min, b.max, width)}" fill="${b.color}" opacity="0.92" />`,
	).join('');
	const needleAngle = valueAngle(value);
	const tip = polar(cx, cy, r - width - 6, needleAngle);
	const band = bandFor(value);
	return `
		<svg viewBox="0 0 ${W} ${H}" class="fg-gauge-svg" role="img"
			aria-label="Fear & Greed gauge at ${value}, ${esc(band.label)}">
			${segs}
			<line x1="${cx}" y1="${cy}" x2="${tip.x.toFixed(2)}" y2="${tip.y.toFixed(2)}"
				stroke="var(--cv-text)" stroke-width="3" stroke-linecap="round" />
			<circle cx="${cx}" cy="${cy}" r="7" fill="var(--cv-text)" />
			<text x="14" y="${cy + 4}" font-size="12" fill="var(--cv-text-3)">0</text>
			<text x="${W - 26}" y="${cy + 4}" font-size="12" fill="var(--cv-text-3)">100</text>
		</svg>`;
}

function renderNow(cur, prev) {
	const band = bandFor(cur.value);
	let delta = '';
	if (prev && Number.isFinite(prev.value)) {
		const d = cur.value - prev.value;
		const up = d >= 0;
		delta =
			d === 0
				? `<p class="fg-delta">Unchanged from last week</p>`
				: `<p class="fg-delta ${up ? 'cv-up' : 'cv-down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${Math.abs(d)} pts vs last week <span class="dim">(was ${prev.value})</span></p>`;
	}
	$('fg-now').innerHTML = `
		<div class="fg-now-card">
			<div class="fg-gauge">${gaugeSvg(cur.value)}
				<div class="fg-gauge-center">
					<span class="fg-value" style="color:${band.color}">${cur.value}</span>
					<span class="fg-label" style="color:${band.color}">${esc(band.label)}</span>
				</div>
			</div>
			<div class="fg-now-meta">
				<p class="fg-now-title">Current market sentiment</p>
				${delta}
				<p class="cv-updated">Updated ${esc(formatDateShort(new Date(cur.ts).toISOString()))} · source: alternative.me</p>
				<div class="fg-cross">
					<a class="cv-pill" href="/coins">Markets ↗</a>
					<a class="cv-pill" href="/heatmap">Heatmap ↗</a>
				</div>
			</div>
		</div>`;
}

// ── History chart ─────────────────────────────────────────────────────────────

const CHART_W = 760;
const CHART_H = 260;
const PAD = { top: 16, right: 16, bottom: 26, left: 34 };
const RANGES = [
	{ label: '30D', limit: 30 },
	{ label: '90D', limit: 90 },
	{ label: '1Y', limit: 365 },
];
const chartState = { limit: 90, history: [], loading: true, error: null };

function chartGeometry(history) {
	const w = CHART_W - PAD.left - PAD.right;
	const h = CHART_H - PAD.top - PAD.bottom;
	const pts = history.map((d, i) => ({
		x: PAD.left + (i / Math.max(1, history.length - 1)) * w,
		y: PAD.top + h - (Math.max(0, Math.min(100, d.value)) / 100) * h,
		d,
	}));
	const line = pts
		.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
		.join(' ');
	const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${PAD.top + h} L${pts[0].x.toFixed(1)},${PAD.top + h} Z`;
	return { pts, line, area, w, h };
}

function renderChart() {
	const el = $('fg-chart');
	const { history, loading, error, limit } = chartState;
	const rangeBtns = RANGES.map(
		(r) =>
			`<button type="button" class="cv-range-btn" data-limit="${r.limit}" aria-pressed="${r.limit === limit}">${r.label}</button>`,
	).join('');

	let body;
	if (loading) {
		body =
			'<div class="cv-chart-state"><span class="cv-spinner" aria-hidden="true"></span>Loading history…</div>';
	} else if (error || history.length < 2) {
		body = '<div class="cv-chart-state">History unavailable right now.</div>';
	} else {
		const g = chartGeometry(history);
		// Horizontal band-threshold guides at 25/45/55/75.
		const h = CHART_H - PAD.top - PAD.bottom;
		const guides = [25, 45, 55, 75]
			.map((v) => {
				const y = PAD.top + h - (v / 100) * h;
				return `<line x1="${PAD.left}" y1="${y}" x2="${CHART_W - PAD.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.6"/><text x="${PAD.left - 6}" y="${y + 3}" font-size="9" fill="var(--cv-text-3)" text-anchor="end">${v}</text>`;
			})
			.join('');
		body = `
			<div class="cv-chart-area">
				<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="Fear & Greed index over ${limit} days">
					<defs>
						<linearGradient id="fg-grad" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="var(--cv-accent)" stop-opacity="0.22"/>
							<stop offset="100%" stop-color="var(--cv-accent)" stop-opacity="0.02"/>
						</linearGradient>
					</defs>
					${guides}
					<path d="${g.area}" fill="url(#fg-grad)"/>
					<path d="${g.line}" fill="none" stroke="var(--cv-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					<g id="fg-cross" hidden>
						<line id="fg-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						<circle id="fg-cross-dot" r="4" fill="var(--cv-accent)" stroke="var(--cv-surface)" stroke-width="2"/>
					</g>
				</svg>
				<div class="cv-chart-tip" id="fg-tip" hidden>
					<p class="p cv-mono" id="fg-tip-val"></p>
					<p class="d" id="fg-tip-date"></p>
				</div>
			</div>`;
	}

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">Index history</span></div>
				<div class="cv-ranges" role="group" aria-label="History time range">${rangeBtns}</div>
			</div>
			${body}
		</div>`;

	el.querySelectorAll('.cv-range-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const l = Number(btn.dataset.limit);
			if (l === chartState.limit) return;
			chartState.limit = l;
			loadChart();
		});
	});
	wireChartPointer();
}

function wireChartPointer() {
	const svg = $('fg-chart').querySelector('svg');
	const tip = $('fg-tip');
	if (!svg || !tip || chartState.history.length < 2) return;
	const g = chartGeometry(chartState.history);
	const cross = svg.querySelector('#fg-cross');
	const line = svg.querySelector('#fg-cross-line');
	const dot = svg.querySelector('#fg-cross-dot');

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mx = ((clientX - rect.left) / rect.width) * CHART_W;
		const n = chartState.history.length;
		const i = Math.max(0, Math.min(n - 1, Math.round(((mx - PAD.left) / g.w) * (n - 1))));
		const p = g.pts[i];
		const band = bandFor(p.d.value);
		cross.removeAttribute('hidden');
		line.setAttribute('x1', p.x);
		line.setAttribute('x2', p.x);
		dot.setAttribute('cx', p.x);
		dot.setAttribute('cy', p.y);
		dot.setAttribute('fill', band.color);
		tip.hidden = false;
		tip.style.left = `${(p.x / CHART_W) * 100}%`;
		$('fg-tip-val').textContent = `${p.d.value} · ${band.label}`;
		$('fg-tip-date').textContent = formatChartTick(p.d.ts, chartState.limit);
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
}

async function loadChart() {
	chartState.loading = true;
	chartState.error = null;
	renderChart();
	try {
		const { history } = await getJson(`/api/coin/fear-greed?limit=${chartState.limit}`);
		chartState.history = Array.isArray(history) ? history : [];
		chartState.loading = false;
	} catch (err) {
		chartState.loading = false;
		chartState.error = err;
		chartState.history = [];
	}
	renderChart();
}

// ── Legend ────────────────────────────────────────────────────────────────────

function renderLegend() {
	const rows = BANDS.map(
		(b) => `
		<div class="fg-band">
			<span class="swatch" style="background:${b.color}"></span>
			<span class="range cv-mono">${b.min}–${b.max}</span>
			<span class="name">${esc(b.label)}</span>
		</div>`,
	).join('');
	$('fg-legend').innerHTML = `
		<div class="cv-card fg-legend-card">
			<h2 class="cv-h2">How to read it</h2>
			<div class="fg-bands">${rows}</div>
			<div class="cv-prose">
				<p>The index distils market emotion into a single 0–100 score. Extreme fear can signal
				that investors are over-sold and a buying opportunity may be near; extreme greed often
				means the market is due for a correction. It is a sentiment gauge, not financial advice —
				pair it with the <a href="/coins">markets table</a> and the
				<a href="/heatmap">heatmap</a> before acting.</p>
			</div>
		</div>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
	$('fg-now').innerHTML = '<div class="cv-skel" style="height:14rem"></div>';
	renderLegend();
	loadChart(); // history + current both live here for the initial 90d window
	try {
		const { current, previous_week } = await getJson('/api/coin/fear-greed?limit=90');
		renderNow(current, previous_week);
	} catch {
		$('fg-now').innerHTML =
			'<div class="cv-empty">The Fear &amp; Greed index is unavailable right now. Please try again shortly.</div>';
	}
}

init();
