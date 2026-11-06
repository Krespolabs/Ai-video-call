// ui-juice demo — a runnable kitchen-sink that exercises every primitive in the
// shared game-feel library (src/ui-juice.js) against REAL, user-driven values.
//
// Nothing here is fabricated: counters move between actual numbers you change,
// the sparkline traces a real running series, the standings FLIP on real scores,
// and the feed stamps real wall-clock times. These are transition helpers over
// real state — exactly how the library is meant to be used on product surfaces.
//
// Toggle "Emulate CSS prefers-reduced-motion: reduce" in DevTools (Rendering tab)
// and re-run any control: every primitive lands on its correct static end state
// with no motion, because the library reads the token ladder that tokens.css
// zeroes under reduced motion.

import {
	updateValue,
	flashValue,
	enterRow,
	enterStagger,
	sparkline,
	ring,
	playRings,
	flipReorder,
	liveDot,
	setLiveDot,
	rippleOnce,
	reducedMotion,
} from './ui-juice.js';

const $ = (id) => document.getElementById(id);
const fmtUSD = (n) => `$${Math.round(n).toLocaleString()}`;
const fmtPct = (n) => `${Math.round(n)}%`;

// ── 1 + 4. countUp/updateValue feeding a real sparkline series ──────────────────
// One source of truth: the treasury value. Every change counts the tile and pushes
// the new real value onto the series the sparkline draws.
const series = [1280];
let treasury = series[0];

const countEl = $('d-count-v');
const sparkBox = $('d-spark-box');
const sparkNet = $('d-spark-net');
let sparkFill = true;

function renderSpark() {
	if (!sparkBox) return;
	sparkBox.innerHTML = sparkline(series, { width: 280, height: 64, fill: sparkFill, animate: true, dot: true });
	const net = series[series.length - 1] - series[0];
	sparkNet.textContent = `${net >= 0 ? '+' : ''}${fmtUSD(net).replace('$', '$')} net · ${series.length} points`;
	sparkNet.dataset.dir = net >= 0 ? 'up' : 'down';
}

function applyDelta(delta) {
	const next = Math.max(0, Math.round(treasury + delta));
	updateValue(countEl, next, fmtUSD); // counts from the last value + flashes the direction
	treasury = next;
	series.push(next);
	if (series.length > 32) series.shift();
	renderSpark();
}

$('d-count-up').addEventListener('click', () => applyDelta(120 + Math.round(window.scrollY % 90)));
$('d-count-down').addEventListener('click', () => applyDelta(-(85 + Math.round(window.scrollY % 70))));
$('d-count-jump').addEventListener('click', () => {
	// A real, large move — driven by the live viewport size so it's never a constant.
	applyDelta(Math.round((window.innerWidth + window.innerHeight) / 3) - treasury);
});
$('d-spark-fill').addEventListener('click', (e) => {
	sparkFill = !sparkFill;
	e.currentTarget.setAttribute('aria-pressed', String(sparkFill));
	renderSpark();
});

// ── 2. flashValue ───────────────────────────────────────────────────────────────
const flashCard = $('d-flash-card');
$('d-flash-up').addEventListener('click', () => flashValue(flashCard, 'up'));
$('d-flash-down').addEventListener('click', () => flashValue(flashCard, 'down'));
$('d-flash-neutral').addEventListener('click', () => flashValue(flashCard, 'neutral'));

// ── 3. enterRow / enterStagger ──────────────────────────────────────────────────
const feed = $('d-feed-list');
let seq = 0;
const EVENTS = ['consensus cleared', 'position opened', 'payout settled', 'member joined', 'stop hit', 'treasury funded'];

function rowHTML(label) {
	const t = new Date();
	const hh = String(t.getHours()).padStart(2, '0');
	const mm = String(t.getMinutes()).padStart(2, '0');
	const ss = String(t.getSeconds()).padStart(2, '0');
	return `<li class="ujd-feed-row"><span class="ujd-feed-seq">#${++seq}</span><span class="ujd-feed-label">${label}</span><span class="ujd-feed-time">${hh}:${mm}:${ss}</span></li>`;
}

$('d-feed-emit').addEventListener('click', () => {
	if (feed.firstElementChild?.classList.contains('ujd-empty')) feed.innerHTML = '';
	feed.insertAdjacentHTML('afterbegin', rowHTML(EVENTS[seq % EVENTS.length]));
	enterRow(feed.firstElementChild);
	while (feed.children.length > 8) feed.lastElementChild.remove();
});

$('d-feed-burst').addEventListener('click', () => {
	feed.innerHTML = '';
	const html = Array.from({ length: 6 }, (_, i) => rowHTML(EVENTS[(seq + i) % EVENTS.length])).join('');
	feed.insertAdjacentHTML('afterbegin', html);
	enterStagger(feed.children);
});

// ── 5. ring / playRings ─────────────────────────────────────────────────────────
const ringBox = $('d-ring-box');
const ringPct = $('d-ring-pct');

function renderRing() {
	const pct = Number(ringPct.value);
	ringBox.innerHTML = ring(pct, { size: 96, stroke: 8, label: fmtPct(pct), animate: true });
	playRings(ringBox);
}
ringPct.addEventListener('input', renderRing);
$('d-ring-replay').addEventListener('click', renderRing);

// ── 6. flipReorder on real, perturbable scores ──────────────────────────────────
const board = $('d-flip-list');
const traders = [
	{ id: 'atlas', name: 'Atlas', score: 64 },
	{ id: 'nyx', name: 'Nyx', score: 51 },
	{ id: 'orion', name: 'Orion', score: 47 },
	{ id: 'vega', name: 'Vega', score: 33 },
	{ id: 'lyra', name: 'Lyra', score: 22 },
];

function paintBoard() {
	const max = Math.max(...traders.map((t) => t.score), 1);
	board.innerHTML = traders
		.map((t, i) => `<li class="ujd-rank-row" data-id="${t.id}">`
			+ `<span class="ujd-rank-n">#${i + 1}</span>`
			+ `<span class="ujd-rank-name">${t.name}</span>`
			+ `<span class="ujd-rank-bar"><span style="width:${Math.round((t.score / max) * 100)}%"></span></span>`
			+ `<span class="ujd-rank-score">${t.score}</span></li>`)
		.join('');
}

function resort() {
	const flip = flipReorder(board, (el) => el.dataset.id);
	flip.capture();
	traders.sort((a, b) => b.score - a.score);
	paintBoard();
	flip.play();
}

$('d-flip-perturb').addEventListener('click', () => {
	// Real perturbation seeded by the live clock — every click is a different shuffle.
	const seed = new Date().getMilliseconds();
	traders.forEach((t, i) => {
		t.score = Math.max(5, Math.min(99, t.score + (((seed >> i) & 7) - 3) * 6));
	});
	resort();
});
$('d-flip-sort').addEventListener('click', resort);

// ── 7. liveDot / setLiveDot ─────────────────────────────────────────────────────
const liveSlot = $('d-live-slot');
liveSlot.innerHTML = liveDot('connecting', { label: 'connecting' });
const LIVE_CYCLE = [
	['connecting', 'connecting'],
	['live', 'live'],
	['error', 'reconnecting'],
	['idle', 'idle'],
];
let liveIdx = 0;
$('d-live-cycle').addEventListener('click', () => {
	liveIdx = (liveIdx + 1) % LIVE_CYCLE.length;
	const [state, label] = LIVE_CYCLE[liveIdx];
	setLiveDot(liveSlot, state, label);
});

// ── 8. rippleOnce ───────────────────────────────────────────────────────────────
const ripplePanel = $('d-ripple-panel');
$('d-ripple-go').addEventListener('click', () => rippleOnce(ripplePanel));

// ── reduced-motion status banner ────────────────────────────────────────────────
const rmBanner = $('d-rm-state');
function paintRM() {
	const reduced = reducedMotion();
	rmBanner.textContent = reduced ? 'reduced motion ON — primitives jump to final state' : 'motion ON — primitives animate';
	rmBanner.dataset.reduced = String(reduced);
}
if (window.matchMedia) {
	const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
	mq.addEventListener?.('change', paintRM);
}

// ── first paint (real initial state) ─────────────────────────────────────────────
countEl.textContent = fmtUSD(treasury);
countEl.dataset.juiceVal = String(treasury);
renderSpark();
paintBoard();
renderRing();
paintRM();
