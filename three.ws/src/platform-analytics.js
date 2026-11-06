/**
 * /analytics: every platform total three.ws publishes about itself, with a
 * growth chart per metric and the method behind each number.
 *
 * Nothing on the page is typed in: every figure, label and method string comes
 * from GET /api/platform/analytics. Charts are native canvas (the pattern from
 * src/agent-economy-volume.js) and each one carries a screen-reader table of the
 * same series, so no number is canvas-only.
 */

const ENDPOINT = '/api/platform/analytics';
const WINDOWS = ['30d', '90d', 'all'];
const VIEWS = ['daily', 'cumulative'];
const REFRESH_MS = 5 * 60_000;

// Where a reader goes to add to each number. Links only, never figures.
const NEXT_STEP = {
	agents: { href: '/create', text: 'Create an agent' },
	agents_with_wallet: { href: '/agent-wallet', text: 'Open an agent wallet' },
	coins_launched: { href: '/launches', text: 'See every launch' },
	models_generated: { href: '/forge', text: 'Generate a 3D model' },
	llm_tokens: { href: '/chat', text: 'Talk to an agent' },
	x402_settlements: { href: '/x402', text: 'Browse paid x402 endpoints' },
	x402_volume_usd: { href: '/x402', text: 'Browse paid x402 endpoints' },
	marketplace_sales: { href: '/marketplace', text: 'Browse the skill marketplace' },
	marketplace_volume_three: { href: '/marketplace', text: 'Browse the skill marketplace' },
	marketplace_volume_usd: { href: '/marketplace', text: 'Browse the skill marketplace' },
	hire_volume_usd: { href: '/agent-economy-volume', text: 'Open the agent economy dashboard' },
	creator_fees: { href: '/launch', text: 'Launch a coin for your agent' },
};

const WINDOW_PHRASE = { '30d': 'in the last 30 days', '90d': 'in the last 90 days', all: 'since launch' };

const state = {
	window: '30d',
	view: 'daily',
	data: null, // last successful body for state.window
	byWindow: new Map(), // window -> body, so switching back is instant
	loading: false,
	requestSeq: 0,
};

const charts = new Map(); // metric key -> { canvas, tip, points, geometry }

// ── Formatting ──────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat(undefined);
const compactNf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function fmtValue(unit, v, { compact = false } = {}) {
	if (v == null || !Number.isFinite(Number(v))) return 'n/a';
	const n = Number(v);
	if (unit === 'usd') {
		if (compact && Math.abs(n) >= 100_000) return `$${compactNf.format(n)}`;
		return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
	}
	if (unit === 'sol') {
		const digits = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 3 : 4;
		const body = compact && Math.abs(n) >= 100_000 ? compactNf.format(n) : n.toLocaleString(undefined, { maximumFractionDigits: digits });
		return `${body} SOL`;
	}
	if (unit === 'three') {
		const body = compact && Math.abs(n) >= 100_000 ? compactNf.format(n) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
		return `${body} $THREE`;
	}
	if (compact && Math.abs(n) >= 100_000) return compactNf.format(n);
	return nf.format(Math.round(n));
}

function axisLabel(unit, v) {
	const prefix = unit === 'usd' ? '$' : '';
	if (Math.abs(v) >= 1000) return `${prefix}${compactNf.format(v)}`;
	return `${prefix}${Number(v.toPrecision(3))}`;
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function dayLabel(key, opts = { month: 'short', day: 'numeric' }) {
	const [y, m, d] = String(key).split('-').map(Number);
	if (!Number.isFinite(y)) return String(key);
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

function relTime(iso) {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return '';
	const s = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	return `${h} h ago`;
}

// ── URL state ───────────────────────────────────────────────────────────────

function readUrl() {
	const q = new URLSearchParams(location.search);
	const w = q.get('window');
	const v = q.get('view');
	state.window = WINDOWS.includes(w) ? w : '30d';
	state.view = VIEWS.includes(v) ? v : 'daily';
}

function writeUrl() {
	const q = new URLSearchParams(location.search);
	if (state.window === '30d') q.delete('window');
	else q.set('window', state.window);
	if (state.view === 'daily') q.delete('view');
	else q.set('view', state.view);
	const qs = q.toString();
	history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

function syncToggles() {
	document.querySelectorAll('#pa-window button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.window === state.window)));
	document.querySelectorAll('#pa-view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
}

// ── Series ──────────────────────────────────────────────────────────────────

function viewSeries(metric) {
	const daily = metric.daily || [];
	if (state.view === 'daily') return daily;
	// Running total: start from everything recorded before the window, so the
	// line ends on the all-time total the tile above shows.
	let run = Number(metric.total || 0) - Number(metric.window_total || 0);
	return daily.map((d) => {
		run += d.value;
		return { day: d.day, value: run };
	});
}

// ── Skeletons and states ────────────────────────────────────────────────────

function skeletonTiles(n = 8) {
	return Array.from({ length: n }, (_, i) =>
		`<div class="pa-tile" aria-hidden="true"><div class="skeleton" style="width:55%;height:12px;animation-delay:.${i % 5}s"></div><div class="skeleton" style="width:70%;height:28px;margin-top:12px;animation-delay:.${i % 5}s"></div><div class="skeleton" style="width:45%;height:11px;margin-top:10px;animation-delay:.${i % 5}s"></div></div>`,
	).join('');
}

function skeletonCharts(n = 4) {
	return Array.from({ length: n }, (_, i) =>
		`<div class="pa-card" aria-hidden="true"><div class="skeleton" style="width:40%;height:14px;animation-delay:.${i}s"></div><div class="skeleton pa-chart-skel" style="animation-delay:.${i}s"></div></div>`,
	).join('');
}

function renderLoading() {
	document.getElementById('pa-tiles').innerHTML = skeletonTiles();
	document.getElementById('pa-tiles').setAttribute('aria-busy', 'true');
	document.getElementById('pa-charts').innerHTML = skeletonCharts();
	document.getElementById('pa-charts').setAttribute('aria-busy', 'true');
	document.getElementById('pa-methods').innerHTML = Array.from({ length: 4 }, () =>
		'<div class="pa-method" aria-hidden="true"><div class="skeleton" style="width:30%;height:13px"></div><div class="skeleton" style="width:90%;height:12px;margin-top:8px"></div></div>').join('');
	charts.clear();
}

function showError(detail) {
	document.getElementById('pa-error-detail').textContent = detail;
	document.getElementById('pa-error').hidden = false;
	if (state.data) return; // keep the last good numbers on screen
	document.getElementById('pa-tiles').innerHTML = '<p class="pa-empty">The totals could not be loaded. Use Retry above.</p>';
	document.getElementById('pa-charts').innerHTML = '<p class="pa-empty">The growth charts could not be loaded. Use Retry above.</p>';
	document.getElementById('pa-methods').innerHTML = '<p class="pa-empty">The method notes load with the numbers. Use Retry above.</p>';
	for (const id of ['pa-tiles', 'pa-charts']) document.getElementById(id).removeAttribute('aria-busy');
	document.getElementById('pa-updated').textContent = '';
}

function clearError() {
	document.getElementById('pa-error').hidden = true;
}

// ── Tiles ───────────────────────────────────────────────────────────────────

function tile(m) {
	if (!m.available) {
		return `<div class="pa-tile is-unavailable">
			<div class="pa-tile-label">${escapeHtml(m.label)}</div>
			<div class="pa-tile-value is-muted">Unavailable</div>
			<div class="pa-tile-sub">Could not be read just now, so it is not shown as zero.</div>
		</div>`;
	}
	const full = fmtValue(m.unit, m.total);
	const compact = fmtValue(m.unit, m.total, { compact: true });
	const delta = state.window === 'all' ? `${fmtValue(m.unit, m.window_total, { compact: true })} since launch` : `+${fmtValue(m.unit, m.window_total, { compact: true })} ${WINDOW_PHRASE[state.window]}`;
	return `<a class="pa-tile" href="#chart-${escapeHtml(m.key)}">
		<div class="pa-tile-label">${escapeHtml(m.label)}</div>
		<div class="pa-tile-value" title="${escapeHtml(full)}">${escapeHtml(compact)}</div>
		<div class="pa-tile-sub">${escapeHtml(delta)}</div>
	</a>`;
}

function renderTiles(metrics) {
	const el = document.getElementById('pa-tiles');
	el.innerHTML = metrics.map(tile).join('');
	el.removeAttribute('aria-busy');
}

// ── Charts ──────────────────────────────────────────────────────────────────

function chartCard(m) {
	const id = `chart-${escapeHtml(m.key)}`;
	const head = `<div class="pa-card-head">
		<h3>${escapeHtml(m.label)}</h3>
		<span class="pa-card-total">${m.available ? escapeHtml(fmtValue(m.unit, m.window_total, { compact: true })) : ''}</span>
	</div>`;
	if (!m.available) {
		return `<article class="pa-card" id="${id}">${head}<div class="pa-chart-msg">This series could not be read just now. <button type="button" class="pa-link-btn" data-retry>Retry</button></div></article>`;
	}
	if (!m.daily.some((d) => d.value > 0)) {
		const next = NEXT_STEP[m.key];
		return `<article class="pa-card" id="${id}">${head}<div class="pa-chart-msg"><span>Nothing recorded ${escapeHtml(WINDOW_PHRASE[state.window])}.</span>${next ? `<a href="${next.href}">${escapeHtml(next.text)}</a>` : ''}</div></article>`;
	}
	return `<article class="pa-card" id="${id}">${head}
		<div class="pa-chart-wrap">
			<canvas class="pa-canvas" role="img" data-key="${escapeHtml(m.key)}"></canvas>
			<div class="pa-tip" aria-hidden="true"></div>
		</div>
		${seriesTable(m)}
	</article>`;
}

function seriesSummary(m, series) {
	const what = state.view === 'daily' ? 'Daily' : 'Running total of';
	const last = series[series.length - 1];
	return `${what} ${m.label.toLowerCase()} ${WINDOW_PHRASE[state.window]}: ${fmtValue(m.unit, m.window_total)} in the window${last ? `, ${fmtValue(m.unit, last.value)} on ${dayLabel(last.day, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}.`;
}

// The canvas is invisible to assistive tech, so the same numbers are also an
// offscreen table. Days with nothing recorded are skipped; a table of zeros is
// noise, not data.
function seriesTable(m) {
	const rows = (m.daily || []).filter((d) => d.value > 0);
	if (!rows.length) return '';
	return `<div class="visually-hidden"><table>
		<caption>${escapeHtml(m.label)} per day, ${escapeHtml(WINDOW_PHRASE[state.window])}</caption>
		<thead><tr><th scope="col">Day</th><th scope="col">${escapeHtml(m.label)}</th></tr></thead>
		<tbody>${rows.map((d) => `<tr><th scope="row">${escapeHtml(dayLabel(d.day, { year: 'numeric', month: 'short', day: 'numeric' }))}</th><td>${escapeHtml(fmtValue(m.unit, d.value))}</td></tr>`).join('')}</tbody>
	</table></div>`;
}

function cssVar(name, fallback) {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return v || fallback;
}

function niceStep(raw) {
	const p = 10 ** Math.floor(Math.log10(raw));
	const f = raw / p;
	return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Four even gridline intervals on round numbers. Counts never get a fractional
// tick (a "0.7 coins" gridline reads as a bug). The running-total view starts
// its axis near the window's first value so growth is visible, not flattened.
function axisScale(values, unit, fromZero) {
	const max = Math.max(...values, 0);
	const min = fromZero ? 0 : Math.min(...values);
	const whole = unit === 'count' || unit === 'tokens';
	let step = niceStep(Math.max((max - min) / 4, whole ? 1 : 1e-6));
	if (whole) step = Math.max(1, Math.ceil(step));
	let lo = fromZero ? 0 : Math.floor(min / step) * step;
	while (lo + step * 4 < max) {
		step = niceStep(step * 1.01);
		lo = fromZero ? 0 : Math.floor(min / step) * step;
	}
	return { lo, hi: lo + step * 4, ticks: 4 };
}

function drawChart(entry) {
	const { canvas, metric } = entry;
	const series = viewSeries(metric);
	const rect = canvas.getBoundingClientRect();
	if (!rect.width) return;
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(rect.height * dpr);
	const ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, rect.width, rect.height);

	const W = rect.width;
	const H = rect.height;
	const pad = { top: 10, right: 8, bottom: 24, left: 46 };
	const cw = W - pad.left - pad.right;
	const ch = H - pad.top - pad.bottom;
	const values = series.map((d) => d.value);
	const { lo, hi, ticks } = axisScale(values, metric.unit, state.view === 'daily');
	const yOf = (v) => pad.top + ch - ((v - lo) / (hi - lo || 1)) * ch;

	const ink = cssVar('--ink-dim', '#888');
	const grid = cssVar('--stroke', 'rgba(128,128,128,.15)');
	const mark = cssVar('--pa-mark', '#8b5cf6');
	const markSoft = cssVar('--pa-mark-soft', 'rgba(139,92,246,.16)');
	const surface = cssVar('--bg-0', '#0a0a0a');

	// Recessive grid and y labels.
	ctx.font = '10px Inter, system-ui, sans-serif';
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'right';
	for (let i = 0; i <= ticks; i++) {
		const v = lo + ((hi - lo) * i) / ticks;
		const y = yOf(v);
		ctx.strokeStyle = grid;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(pad.left, Math.round(y) + 0.5);
		ctx.lineTo(pad.left + cw, Math.round(y) + 0.5);
		ctx.stroke();
		ctx.fillStyle = ink;
		ctx.fillText(axisLabel(metric.unit, v), pad.left - 6, y);
	}

	// Sparse x labels.
	ctx.textAlign = 'center';
	ctx.textBaseline = 'alphabetic';
	const n = series.length;
	const slot = cw / Math.max(1, n);
	const xOf = (i) => pad.left + slot * i + slot / 2;
	const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(cw / 70))));
	series.forEach((d, i) => {
		if (i % labelEvery !== 0) return;
		ctx.fillStyle = ink;
		ctx.fillText(dayLabel(d.day), Math.min(W - 24, Math.max(pad.left + 14, xOf(i))), H - 6);
	});

	if (state.view === 'daily') {
		// Thin bars, 2px surface gap, rounded data end anchored to the baseline.
		const gap = slot >= 8 ? 2 : slot >= 3 ? 1 : 0;
		const barW = Math.max(1, slot - gap);
		ctx.fillStyle = mark;
		series.forEach((d, i) => {
			if (d.value <= 0) return;
			const top = yOf(d.value);
			const h = Math.max(2, pad.top + ch - top);
			const x = pad.left + slot * i + gap / 2;
			ctx.beginPath();
			ctx.roundRect(x, pad.top + ch - h, barW, h, barW >= 6 ? [Math.min(4, barW / 2), Math.min(4, barW / 2), 0, 0] : 0);
			ctx.fill();
		});
	} else {
		ctx.beginPath();
		series.forEach((d, i) => {
			const x = xOf(i);
			const y = yOf(d.value);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.lineTo(xOf(n - 1), pad.top + ch);
		ctx.lineTo(xOf(0), pad.top + ch);
		ctx.closePath();
		ctx.fillStyle = markSoft;
		ctx.fill();
		ctx.beginPath();
		series.forEach((d, i) => {
			const x = xOf(i);
			const y = yOf(d.value);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.strokeStyle = mark;
		ctx.lineWidth = 2;
		ctx.lineJoin = 'round';
		ctx.stroke();
	}

	// Hover crosshair for the active day.
	if (entry.hover != null && series[entry.hover]) {
		const i = entry.hover;
		const x = xOf(i);
		ctx.strokeStyle = ink;
		ctx.globalAlpha = 0.5;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(Math.round(x) + 0.5, pad.top);
		ctx.lineTo(Math.round(x) + 0.5, pad.top + ch);
		ctx.stroke();
		ctx.globalAlpha = 1;
		if (state.view === 'cumulative') {
			const y = yOf(series[i].value);
			ctx.beginPath();
			ctx.arc(x, y, 4, 0, Math.PI * 2);
			ctx.fillStyle = mark;
			ctx.strokeStyle = surface;
			ctx.lineWidth = 2;
			ctx.fill();
			ctx.stroke();
		}
	}

	entry.series = series;
	entry.geometry = { left: pad.left, slot, top: pad.top, yOf, xOf };
	canvas.setAttribute('aria-label', seriesSummary(metric, series));
}

function wireChart(entry) {
	const { canvas, tip, metric } = entry;
	const move = (clientX) => {
		const g = entry.geometry;
		if (!g || !entry.series?.length) return;
		const rect = canvas.getBoundingClientRect();
		const i = Math.min(entry.series.length - 1, Math.max(0, Math.floor((clientX - rect.left - g.left) / g.slot)));
		const d = entry.series[i];
		entry.hover = i;
		drawChart(entry);
		tip.innerHTML = `<div class="pa-tip-day">${escapeHtml(dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</div>
			<div class="pa-tip-val">${escapeHtml(fmtValue(metric.unit, d.value))}</div>
			<div class="pa-tip-day">${state.view === 'daily' ? 'that day' : 'running total'}</div>`;
		const wrapW = canvas.parentElement.clientWidth;
		const x = g.xOf(i);
		tip.style.left = `${Math.min(wrapW - 70, Math.max(70, x))}px`;
		tip.style.top = `${Math.max(8, g.yOf(d.value) - 10)}px`;
		tip.dataset.open = '1';
	};
	const leave = () => {
		entry.hover = null;
		tip.dataset.open = '0';
		drawChart(entry);
	};
	canvas.addEventListener('pointermove', (e) => move(e.clientX));
	canvas.addEventListener('pointerdown', (e) => move(e.clientX));
	canvas.addEventListener('pointerleave', leave);
}

function renderCharts(metrics) {
	const el = document.getElementById('pa-charts');
	const charted = metrics;
	el.innerHTML = charted.map(chartCard).join('');
	el.removeAttribute('aria-busy');
	charts.clear();
	el.querySelectorAll('canvas.pa-canvas').forEach((canvas) => {
		const metric = charted.find((m) => m.key === canvas.dataset.key);
		const entry = { canvas, tip: canvas.parentElement.querySelector('.pa-tip'), metric, hover: null };
		charts.set(metric.key, entry);
		wireChart(entry);
	});
	el.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => load({ force: true })));
	requestAnimationFrame(redrawAll);
}

function redrawAll() {
	for (const entry of charts.values()) {
		entry.hover = null;
		if (entry.tip) entry.tip.dataset.open = '0';
		drawChart(entry);
	}
}

// ── Methods ─────────────────────────────────────────────────────────────────

function renderMethods(metrics, body) {
	const items = metrics.map((m) => `<div class="pa-method">
		<dt>${escapeHtml(m.label)}${m.available ? '' : ' <span class="pa-badge is-warn">Unavailable now</span>'}</dt>
		<dd>${escapeHtml(m.method)}</dd>
	</div>`);
	items.push(`<div class="pa-method">
		<dt>Days and windows</dt>
		<dd>Days are UTC calendar days. This window runs from ${escapeHtml(dayLabel(body.from, { year: 'numeric', month: 'short', day: 'numeric' }))} to ${escapeHtml(dayLabel(body.to, { year: 'numeric', month: 'short', day: 'numeric' }))} (${escapeHtml(nf.format(body.window_days))} days). "Running total" adds each day to everything recorded before the window, so it ends on the all-time total. Totals are cached for up to five minutes.</dd>
	</div>`);
	document.getElementById('pa-methods').innerHTML = items.join('');
}

// ── Render + data ───────────────────────────────────────────────────────────

function render(body) {
	const metrics = Object.values(body.metrics || {});
	renderTiles(metrics);
	renderCharts(metrics);
	renderMethods(metrics, body);
	renderUpdated(body);
	const failed = (body.errors || []).length;
	const note = document.getElementById('pa-partial');
	note.hidden = !failed;
	if (failed) note.textContent = `${failed === 1 ? 'One figure' : `${failed} figures`} could not be read just now and ${failed === 1 ? 'is' : 'are'} marked unavailable. Everything else is current.`;
}

function renderUpdated(body) {
	const el = document.getElementById('pa-updated');
	const at = new Date(body.updated_at);
	el.innerHTML = `Updated <time datetime="${escapeHtml(body.updated_at)}" title="${escapeHtml(at.toLocaleString())}">${escapeHtml(relTime(body.updated_at))}</time>`;
}

async function load({ force = false } = {}) {
	const windowKey = state.window;
	const cached = state.byWindow.get(windowKey);
	if (cached && !force) {
		state.data = cached;
		clearError();
		render(cached);
		// Fresh enough: the server caches for the same five minutes anyway.
		if (Date.now() - cached.fetchedAt < REFRESH_MS) return;
	} else if (!cached) {
		renderLoading();
	}

	const seq = ++state.requestSeq;
	state.loading = true;
	document.getElementById('pa-retry').disabled = true;
	let body;
	try {
		const res = await fetch(`${ENDPOINT}?window=${encodeURIComponent(windowKey)}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`http_${res.status}`);
		body = await res.json();
		if (!body || typeof body.metrics !== 'object') throw new Error('bad_body');
	} catch (err) {
		if (seq !== state.requestSeq) return;
		state.loading = false;
		document.getElementById('pa-retry').disabled = false;
		const status = /^http_(\d+)$/.exec(err?.message || '')?.[1];
		if (status === '429') showError('Too many requests from this network. Wait a moment, then retry.');
		else if (status) showError(`The analytics service answered HTTP ${status}.`);
		else if (err?.message === 'bad_body') showError('The analytics service sent a response this page could not read.');
		else showError('Network error: check your connection, then retry.');
		return;
	}
	if (seq !== state.requestSeq) return; // a newer window was picked meanwhile
	state.loading = false;
	document.getElementById('pa-retry').disabled = false;
	clearError();
	const everyMetricFailed = Object.values(body.metrics).every((m) => !m.available);
	if (everyMetricFailed) {
		state.byWindow.delete(windowKey);
		state.data = null;
		showError('The database behind these numbers is unreachable right now.');
		return;
	}
	body.fetchedAt = Date.now();
	state.byWindow.set(windowKey, body);
	state.data = body;
	render(body);
}

function init() {
	readUrl();
	syncToggles();

	document.getElementById('pa-window').addEventListener('click', (e) => {
		const b = e.target.closest('button[data-window]');
		if (!b || b.dataset.window === state.window) return;
		state.window = b.dataset.window;
		syncToggles();
		writeUrl();
		load();
	});
	document.getElementById('pa-view').addEventListener('click', (e) => {
		const b = e.target.closest('button[data-view]');
		if (!b || b.dataset.view === state.view) return;
		state.view = b.dataset.view;
		syncToggles();
		writeUrl();
		if (state.data) render(state.data);
	});
	document.getElementById('pa-retry').addEventListener('click', () => load({ force: true }));
	window.addEventListener('popstate', () => {
		readUrl();
		syncToggles();
		load();
	});

	let raf = 0;
	window.addEventListener('resize', () => {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(redrawAll);
	});
	new MutationObserver(() => requestAnimationFrame(redrawAll)).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});

	load();
	setInterval(() => {
		if (state.data) renderUpdated(state.data);
	}, 30_000);
	setInterval(() => {
		if (document.visibilityState === 'visible' && !state.loading) load({ force: true });
	}, REFRESH_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
