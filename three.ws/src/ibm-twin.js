// Digital Twin — the living 3D market replica.
//
// Pulls a live Solana market's vitals + an IBM Granite TimeSeries projection from
// /api/ibm/twin and renders the asset as a breathing "organism": a core whose
// pulse tracks its heartbeat, whose surface churns with its volatility, and whose
// hue is its state. Its real past flows into the core from the left; Granite's
// projected future sweeps out to the right; a faint back-test shows how well the
// twin has tracked reality. Live sync keeps it in step with the market, and the
// what-if simulator perturbs the twin and re-forecasts. All data is real.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const IBM = {
	blue: 0x0f62fe,
	blueLight: 0x78a9ff,
	up: 0x42be65,
	down: 0xfa4d56,
	warn: 0xf1c21b,
	flat: 0x8d8d8d,
	white: 0xf4f4f4,
};
// State → core hue.
const STATE_COLOR = {
	calm: IBM.blueLight,
	ascending: IBM.up,
	euphoric: 0x6fdc8c,
	declining: IBM.warn,
	stressed: IBM.down,
	dormant: IBM.flat,
};
const SPAN_BACK = 7.5; // world-units of history (left of the core)
const SPAN_FWD = 6.5; // world-units of projection (right of the core)
const HEIGHT = 5.0; // world-units across the price axis

// ── DOM handles ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const stage = $('twin-stage');
const hud = {
	name: $('t-name'),
	state: $('t-state'),
	price: $('t-price'),
	momentum: $('m-momentum'),
	vol: $('m-vol'),
	bpm: $('m-bpm'),
	heart: $('m-heart'),
	activity: $('m-activity'),
	liq: $('m-liq'),
	voltrend: $('m-voltrend'),
	live: $('t-live'),
	synced: $('t-synced'),
	persona: $('t-persona'),
	status: $('t-status'),
	chips: $('t-chips'),
	search: $('t-search'),
	spawn: $('t-spawn'),
	projBadge: $('b-projection'),
	fidBadge: $('b-fidelity'),
	govBadge: $('b-gov'),
	sim: {
		shock: $('s-shock'),
		shockV: $('s-shock-v'),
		vol: $('s-vol'),
		volV: $('s-vol-v'),
		flip: $('s-flip'),
		run: $('s-run'),
		reset: $('s-reset'),
		out: $('s-out'),
		base: $('s-base'),
		sim: $('s-sim'),
		delta: $('s-delta'),
	},
};

// ── Three.js scaffold ─────────────────────────────────────────────────────────
// Build the WebGL renderer defensively. On a device without WebGL the
// constructor throws — so instead of crashing the whole page (and losing the
// vitals + Granite forecast readout, which don't need 3D) we show an inline note
// and hand back an inert stub the scene code below can call harmlessly.
function makeRenderer() {
	try {
		const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		r.setSize(stage.clientWidth, stage.clientHeight);
		r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		stage.appendChild(r.domElement);
		r.ok = true;
		return r;
	} catch {
		const note = document.createElement('div');
		note.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center';
		note.innerHTML =
			'<p style="max-width:34ch;margin:0;color:#8a93a6;font:14px/1.5 system-ui,sans-serif">The live 3D twin needs WebGL, which isn’t available on this device. The vitals and Granite forecast below still work.</p>';
		stage.appendChild(note);
		return { ok: false, domElement: document.createElement('canvas'), setSize() {}, setPixelRatio() {}, render() {}, dispose() {} };
	}
}
const renderer = makeRenderer();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, stage.clientWidth / stage.clientHeight, 0.1, 200);
camera.position.set(0.6, 2.0, 13);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.45;
controls.minDistance = 7;
controls.maxDistance = 22;
controls.maxPolarAngle = Math.PI * 0.62;

// Floor grid
const grid = new THREE.GridHelper(SPAN_BACK + SPAN_FWD + 4, 28, IBM.blue, 0x1b2436);
grid.position.y = -HEIGHT / 2 - 0.8;
grid.material.transparent = true;
grid.material.opacity = 0.3;
scene.add(grid);

// Ambient particle field
const particles = (() => {
	const n = 340;
	const geo = new THREE.BufferGeometry();
	const pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		pos[i * 3] = (Math.random() - 0.5) * (SPAN_BACK + SPAN_FWD) * 1.3;
		pos[i * 3 + 1] = (Math.random() - 0.5) * HEIGHT * 2;
		pos[i * 3 + 2] = (Math.random() - 0.5) * 7;
	}
	geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	const mat = new THREE.PointsMaterial({
		color: IBM.blueLight,
		size: 0.035,
		transparent: true,
		opacity: 0.5,
		depthWrite: false,
	});
	const pts = new THREE.Points(geo, mat);
	scene.add(pts);
	return pts;
})();

// ── The living core — a breathing, churning organism ─────────────────────────
const core = (() => {
	const geo = new THREE.IcosahedronGeometry(1, 4);
	const base = geo.attributes.position.array.slice(); // pristine vertex positions
	const solid = new THREE.Mesh(
		geo,
		new THREE.MeshBasicMaterial({ color: STATE_COLOR.calm, transparent: true, opacity: 0.92 }),
	);
	const shellGeo = new THREE.IcosahedronGeometry(1.28, 2);
	const shell = new THREE.Mesh(
		shellGeo,
		new THREE.MeshBasicMaterial({
			color: IBM.white,
			wireframe: true,
			transparent: true,
			opacity: 0.18,
		}),
	);
	const halo = new THREE.Mesh(
		new THREE.SphereGeometry(1.7, 28, 28),
		new THREE.MeshBasicMaterial({
			color: STATE_COLOR.calm,
			transparent: true,
			opacity: 0.07,
			depthWrite: false,
		}),
	);
	const group = new THREE.Group();
	group.add(halo, solid, shell);
	scene.add(group);
	return { group, solid, shell, halo, geo, base };
})();

// Target vitals the core eases toward (so live updates are smooth, not jumpy).
const vitalsTarget = {
	color: new THREE.Color(STATE_COLOR.calm),
	turbulence: 0.04,
	pulseHz: 1,
	activity: 0.4,
	scale: 1,
};
const vitalsNow = {
	color: new THREE.Color(STATE_COLOR.calm),
	turbulence: 0.04,
	pulseHz: 1,
	activity: 0.4,
	scale: 1,
};

function setVitals(v) {
	if (!v) return;
	const col = STATE_COLOR[v.state?.key] || STATE_COLOR.calm;
	vitalsTarget.color.set(col);
	vitalsTarget.turbulence = 0.03 + (v.signals?.volatility ?? 0) * 0.26;
	vitalsTarget.pulseHz = (v.heartbeatBpm || 60) / 60;
	vitalsTarget.activity = v.signals?.activity ?? 0.4;
	vitalsTarget.scale = 1 + (v.signals?.activity ?? 0.4) * 0.18;
}

// ── Trajectory geometry (history, projection, back-test, scenario) ────────────
let mapY = () => 0;
let mapXHist = () => 0;
let mapXProj = () => 0;

let histGroup = new THREE.Group();
let projGroup = new THREE.Group();
let fidGroup = new THREE.Group();
let simGroup = new THREE.Group();
let projDimmed = false; // true while a scenario has faded the live projection
scene.add(histGroup, projGroup, fidGroup, simGroup);

function disposeGroup(g) {
	g.traverse((o) => {
		if (o.geometry) o.geometry.dispose();
		if (o.material)
			(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
	});
	scene.remove(g);
}
function replace(oldGroup) {
	disposeGroup(oldGroup);
	const g = new THREE.Group();
	scene.add(g);
	return g;
}

function downsample(arr, max) {
	if (arr.length <= max) return arr;
	const step = (arr.length - 1) / (max - 1);
	const out = [];
	for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
	return out;
}

function glowTube(points, color, radius, opacity = 1, clip = null) {
	const curve = new THREE.CatmullRomCurve3(points);
	const seg = Math.min(600, Math.max(8, points.length * 4));
	const core_ = new THREE.Mesh(
		new THREE.TubeGeometry(curve, seg, radius, 8, false),
		new THREE.MeshBasicMaterial({ color, transparent: true, opacity, clippingPlanes: clip }),
	);
	const halo = new THREE.Mesh(
		new THREE.TubeGeometry(curve, seg, radius * 2.6, 8, false),
		new THREE.MeshBasicMaterial({
			color,
			transparent: true,
			opacity: opacity * 0.16,
			depthWrite: false,
			clippingPlanes: clip,
		}),
	);
	const g = new THREE.Group();
	g.add(core_, halo);
	return g;
}
function marker(pos, color, r = 0.13) {
	const m = new THREE.Mesh(
		new THREE.SphereGeometry(r, 18, 18),
		new THREE.MeshBasicMaterial({ color }),
	);
	m.position.copy(pos);
	const halo = new THREE.Mesh(
		new THREE.SphereGeometry(r * 2.4, 18, 18),
		new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }),
	);
	m.add(halo);
	return m;
}
function dashedLine(points, color, opacity) {
	const geo = new THREE.BufferGeometry().setFromPoints(points);
	const mat = new THREE.LineDashedMaterial({
		color,
		transparent: true,
		opacity,
		dashSize: 0.18,
		gapSize: 0.12,
	});
	const line = new THREE.Line(geo, mat);
	line.computeLineDistances();
	return line;
}

// Build the coordinate maps + render history, projection and (optional) back-test.
function renderSnapshot(data) {
	const history = downsample(data.history || [], 150);
	const projection = data.projection?.points || [];
	const fid = data.fidelity;
	if (!history.length) return;

	const current = data.vitals?.currentPrice ?? history[history.length - 1].c;
	const tNow = history[history.length - 1].t;
	const tHist0 = history[0].t;
	const tProjEnd = projection.length ? projection[projection.length - 1].t : tNow + 1;

	const prices = [
		...history.map((p) => p.c),
		...projection.map((p) => p.c),
		...(fid ? fid.realized.map((p) => p.c).concat(fid.predicted.map((p) => p.c)) : []),
	].filter(Number.isFinite);
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	const range = max - min || Math.abs(current) || 1;

	mapY = (c) => ((c - current) / range) * HEIGHT;
	mapXHist = (t) => ((t - tNow) / Math.max(1, tNow - tHist0)) * SPAN_BACK;
	mapXProj = (t) => ((t - tNow) / Math.max(1, tProjEnd - tNow)) * SPAN_FWD;

	// History ribbon flowing into the core.
	histGroup = replace(histGroup);
	const histPts = history.map((p) => new THREE.Vector3(mapXHist(p.t), mapY(p.c), 0));
	histGroup.add(glowTube(histPts, IBM.blueLight, 0.03, 0.85));

	// "Now" seam at the core.
	const seamLine = new THREE.Mesh(
		new THREE.PlaneGeometry(0.012, HEIGHT * 1.1),
		new THREE.MeshBasicMaterial({
			color: IBM.white,
			transparent: true,
			opacity: 0.22,
			side: THREE.DoubleSide,
		}),
	);
	seamLine.position.set(0, 0, 0);
	histGroup.add(seamLine);

	// Projection ghost sweeping out to the right.
	projGroup = replace(projGroup);
	projDimmed = false;
	if (projection.length && data.projection?.stats) {
		const dir = data.projection.stats.direction;
		const col = dir === 'up' ? IBM.up : dir === 'down' ? IBM.down : IBM.flat;
		const seam = new THREE.Vector3(0, 0, 0);
		const fPts = [
			seam,
			...projection.map((p) => new THREE.Vector3(mapXProj(p.t), mapY(p.c), 0)),
		];
		projGroup.add(glowTube(fPts, col, 0.04, 0.95));
		projGroup.add(
			uncertaintyRibbon(
				fPts,
				mapY(data.projection.stats.high) - mapY(data.projection.stats.low),
				col,
			),
		);
		projGroup.add(marker(fPts[fPts.length - 1], col, 0.15));
	}

	// Back-test: faint realized vs predicted, drawn over the recent past so you can
	// literally see how closely the twin tracked reality.
	fidGroup = replace(fidGroup);
	if (fid && fid.realized?.length && fid.predicted?.length) {
		const rPts = fid.realized.map((p) => new THREE.Vector3(mapXHist(p.t), mapY(p.c), 0.02));
		const pPts = fid.predicted.map(
			(p, i) => new THREE.Vector3(mapXHist(fid.realized[i]?.t ?? p.t), mapY(p.c), 0.02),
		);
		fidGroup.add(dashedLine(rPts, IBM.white, 0.35));
		fidGroup.add(dashedLine(pPts, 0x33b1ff, 0.5));
	}

	controls.target.set((SPAN_FWD - SPAN_BACK) / 6, 0, 0);
}

function uncertaintyRibbon(pts, fullBand, color) {
	const half = Math.max(0.05, Math.abs(fullBand) / 2);
	const geo = new THREE.BufferGeometry();
	const verts = [];
	for (let i = 0; i < pts.length; i++) {
		const f = i / (pts.length - 1);
		const hb = half * f;
		verts.push(pts[i].x, pts[i].y + hb, 0, pts[i].x, pts[i].y - hb, 0);
	}
	geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
	const idx = [];
	for (let i = 0; i < pts.length - 1; i++) {
		const a = i * 2;
		idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
	}
	geo.setIndex(idx);
	return new THREE.Mesh(
		geo,
		new THREE.MeshBasicMaterial({
			color,
			transparent: true,
			opacity: 0.14,
			side: THREE.DoubleSide,
			depthWrite: false,
		}),
	);
}

// Render a what-if simulation: baseline ghost (dimmed) + scenario ghost (bold).
function renderScenario(data) {
	simGroup = replace(simGroup);
	if (!data.baseline?.points?.length || !data.simulated?.points?.length) return;
	const seam = new THREE.Vector3(0, 0, 0);
	const basePts = [
		seam,
		...data.baseline.points.map((p) => new THREE.Vector3(mapXProj(p.t), mapY(p.c), 0.04)),
	];
	const simPts = [
		seam,
		...data.simulated.points.map((p) => new THREE.Vector3(mapXProj(p.t), mapY(p.c), 0.04)),
	];
	simGroup.add(dashedLine(basePts, IBM.flat, 0.45));
	const simDir = data.simulated.stats.direction;
	const simCol = simDir === 'up' ? IBM.up : simDir === 'down' ? IBM.down : IBM.warn;
	simGroup.add(glowTube(simPts, IBM.warn, 0.045, 0.95));
	simGroup.add(marker(simPts[simPts.length - 1], simCol, 0.16));
	// Dim the live projection while a scenario is on screen — once, so repeated
	// runs don't compound. renderSnapshot() rebuilds projGroup and clears the flag.
	if (!projDimmed) {
		projGroup.traverse((o) => {
			if (o.material)
				(Array.isArray(o.material) ? o.material : [o.material]).forEach(
					(m) => (m.opacity *= 0.35),
				);
		});
		projDimmed = true;
	}
}
function clearScenario() {
	simGroup = replace(simGroup);
}

// ── Animation loop ────────────────────────────────────────────────────────────
let running = true;
const tmpV = new THREE.Vector3();
function animate() {
	if (!running || !renderer.ok) return;
	requestAnimationFrame(animate);
	const t = performance.now() / 1000;
	controls.update();
	particles.rotation.y += 0.0007;

	// Ease the core vitals toward their targets.
	vitalsNow.color.lerp(vitalsTarget.color, 0.05);
	vitalsNow.turbulence += (vitalsTarget.turbulence - vitalsNow.turbulence) * 0.05;
	vitalsNow.pulseHz += (vitalsTarget.pulseHz - vitalsNow.pulseHz) * 0.05;
	vitalsNow.activity += (vitalsTarget.activity - vitalsNow.activity) * 0.05;
	vitalsNow.scale += (vitalsTarget.scale - vitalsNow.scale) * 0.05;

	core.solid.material.color.copy(vitalsNow.color);
	core.halo.material.color.copy(vitalsNow.color);
	core.halo.material.opacity = 0.05 + vitalsNow.activity * 0.1;
	core.shell.material.opacity = 0.12 + vitalsNow.activity * 0.16;

	// Heartbeat: a sharp pulse at the twin's bpm.
	const beat = Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * vitalsNow.pulseHz), 6);
	const pulse = vitalsNow.scale * (1 + beat * 0.07);
	core.group.scale.setScalar(pulse);
	core.shell.rotation.y += 0.003 + vitalsNow.activity * 0.004;
	core.shell.rotation.x += 0.0016;

	// Volatility churn: displace the core's vertices along their normals via cheap
	// 3-axis sinusoidal noise scaled by turbulence.
	const pos = core.geo.attributes.position;
	const b = core.base;
	const turb = vitalsNow.turbulence;
	for (let i = 0; i < pos.count; i++) {
		const ix = i * 3;
		const bx = b[ix];
		const by = b[ix + 1];
		const bz = b[ix + 2];
		const n =
			Math.sin(bx * 3.1 + t * 2.0) * Math.cos(by * 2.7 - t * 1.6) +
			Math.sin(bz * 3.4 + t * 1.3) * 0.6;
		const d = 1 + n * turb;
		pos.setXYZ(i, bx * d, by * d, bz * d);
	}
	pos.needsUpdate = true;

	renderer.render(scene, camera);
}
function onResize() {
	const w = stage.clientWidth;
	const h = stage.clientHeight;
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', () => {
	running = !document.hidden;
	if (running) animate();
});
animate();

// ── Embodied narrator (optional, graceful) ────────────────────────────────────
const avatar = document.querySelector('agent-3d');
let avatarReady = false;
if (avatar) {
	avatar.addEventListener('agent:ready', () => (avatarReady = true));
	avatar.addEventListener('agent:error', () => (avatarReady = false));
}
function narrate(text, emotion, sentiment) {
	if (!text) return;
	if (avatarReady && typeof avatar.say === 'function') {
		try {
			avatar.say(text, { sentiment });
		} catch {
			speak(text);
		}
		if (emotion) {
			avatar.dispatchEvent(
				new CustomEvent('agent:action', {
					detail: { type: 'emote', payload: { trigger: emotion, weight: 1 } },
				}),
			);
		}
	} else {
		speak(text);
	}
}
function speak(text) {
	try {
		if (!window.speechSynthesis) return;
		window.speechSynthesis.cancel();
		const u = new SpeechSynthesisUtterance(text);
		window.speechSynthesis.speak(u);
	} catch {
		/* no speech available */
	}
}

// ── Formatting ────────────────────────────────────────────────────────────────
const fmtPrice = (p) => {
	if (!Number.isFinite(p)) return '—';
	if (p >= 1) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
	return `$${p.toPrecision(4)}`;
};
const fmtPct = (p, dp = 2) => (Number.isFinite(p) ? `${p >= 0 ? '+' : ''}${p.toFixed(dp)}%` : '—');
const fmtUsd = (v) => {
	if (!Number.isFinite(v)) return '—';
	if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
	if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
	return `$${v.toFixed(0)}`;
};
const STATE_INK = {
	calm: '#78a9ff',
	ascending: '#42be65',
	euphoric: '#6fdc8c',
	declining: '#f1c21b',
	stressed: '#fa4d56',
	dormant: '#8d8d8d',
};

function setStatus(msg, busy = false, onRetry = null) {
	while (hud.status.firstChild) hud.status.removeChild(hud.status.firstChild);
	if (msg) hud.status.appendChild(document.createTextNode(msg));
	if (onRetry && msg) {
		const btn = document.createElement('button');
		btn.className = 'status-retry';
		btn.textContent = 'Retry';
		btn.addEventListener('click', onRetry);
		hud.status.appendChild(btn);
	}
	hud.status.classList.toggle('busy', busy);
	hud.spawn.disabled = busy;
}

// ── State + data flow ─────────────────────────────────────────────────────────
let activeTarget = null; // { pool } | { token }
let syncTimer = null;
const SYNC_MS = 30_000;

async function loadTrending() {
	try {
		const r = await fetch('/api/ibm/twin?list=trending');
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		hud.chips.innerHTML = '';
		(j.pools || []).forEach((p) => {
			const chip = document.createElement('button');
			chip.className = 'chip';
			chip.textContent = p.name;
			chip.title = `${p.name}${p.priceUsd != null ? ' · ' + fmtPrice(p.priceUsd) : ''}`;
			chip.addEventListener('click', () => spawn({ pool: p.pool, label: p.name }));
			hud.chips.appendChild(chip);
		});
		if (j.pools?.[0]) spawn({ pool: j.pools[0].pool, label: j.pools[0].name });
	} catch (e) {
		setStatus(`Could not load trending tokens: ${e.message}`, false, loadTrending);
	}
}

let inFlight = false;
async function spawn(target, { silent = false } = {}) {
	if (inFlight) return;
	inFlight = true;
	const prevTarget = activeTarget;
	activeTarget = target;
	clearScenario();
	hud.sim.out.classList.remove('show');
	if (!silent)
		setStatus(`Mirroring ${target.label || target.token || 'market'} on IBM Granite…`, true);
	try {
		const q = target.pool
			? `pool=${encodeURIComponent(target.pool)}`
			: `token=${encodeURIComponent(target.token)}`;
		const r = await fetch(`/api/ibm/twin?${q}`);
		const data = await r.json();
		if (!r.ok) {
			// Permanent failures: don't leave the failing pool as activeTarget so the
			// live-sync timer doesn't keep hammering the same broken endpoint.
			if (r.status === 422 && data.error === 'insufficient_history') {
				activeTarget = prevTarget;
				setStatus('Not enough trading history to model this pool — try a more active market.');
				return;
			}
			throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
		}
		applySnapshot(data, { silent });
	} catch (e) {
		activeTarget = prevTarget;
		setStatus(`Twin failed: ${e.message}`, false, () => spawn(target));
	} finally {
		inFlight = false;
	}
}

function applySnapshot(data, { silent } = {}) {
	renderSnapshot(data);
	const v = data.vitals || {};
	setVitals(v);

	const tk = data.token || {};
	hud.name.textContent = tk.symbol ? `${tk.name} · ${tk.symbol}` : tk.name || 'Token';
	hud.price.textContent = fmtPrice(v.currentPrice);

	if (v.state) {
		hud.state.textContent = v.state.label;
		hud.state.style.color = STATE_INK[v.state.key] || '#78a9ff';
	}
	const signed = (el, val, dp) => {
		el.textContent = fmtPct(val, dp);
		el.className = 'v ' + (val > 0 ? 'up' : val < 0 ? 'down' : '');
	};
	signed(hud.momentum, v.momentumPct, 1);
	hud.vol.textContent = Number.isFinite(v.volatilityPct) ? `${v.volatilityPct.toFixed(2)}%` : '—';
	hud.bpm.textContent = v.heartbeatBpm ? `${v.heartbeatBpm} bpm` : '—';
	if (v.heartbeatBpm) hud.heart.style.animationDuration = `${(60 / v.heartbeatBpm).toFixed(2)}s`;
	hud.activity.textContent = Number.isFinite(v.activityRatio)
		? `${v.activityRatio.toFixed(2)}×`
		: '—';
	hud.liq.textContent = fmtUsd(v.liquidityUsd);
	signed(hud.voltrend, v.volumeTrendPct, 0);

	// Projection badge
	if (data.projection?.model) {
		hud.projBadge.hidden = false;
		const s = data.projection.stats;
		hud.projBadge.querySelector('.s').textContent =
			`${data.projection.model} · ${fmtPct(s.changePct, 1)} / ${s.horizonHours}h`;
	} else {
		hud.projBadge.hidden = false;
		hud.projBadge.querySelector('.s').textContent =
			data.ibm?.error || data.ibm?.reason || 'projection unavailable';
	}

	// Fidelity badge
	if (data.fidelity && data.fidelity.accuracyPct != null) {
		hud.fidBadge.hidden = false;
		const f = data.fidelity;
		hud.fidBadge.querySelector('.s').textContent =
			`${f.accuracyPct.toFixed(1)}% accurate · ${f.directionalHit ? 'direction ✓' : 'direction ✗'} · ${f.horizonHours}h`;
	} else {
		hud.fidBadge.hidden = true;
	}

	// Governance badge
	if (data.governance && data.governance.passed != null) {
		hud.govBadge.hidden = false;
		const pass = data.governance.passed;
		hud.govBadge.classList.toggle('fail', pass === false);
		hud.govBadge.querySelector('.s').textContent = pass
			? `PASS · ${data.governance.risk}`
			: `FLAGGED · ${data.governance.risk}`;
	} else {
		hud.govBadge.hidden = true;
	}

	// Persona
	const text = data.persona?.text;
	if (text) {
		hud.persona.textContent = text;
		hud.persona.classList.remove('muted');
		if (!silent) narrate(text, v.state?.emotion, v.signals?.trend);
	} else if (data.ibm && !data.ibm.configured) {
		hud.persona.textContent =
			'IBM watsonx is not configured on this deployment — the live Granite projection, self-narration, and Granite Guardian governance run in production. The vitals and chart above are real on-chain data.';
		hud.persona.classList.add('muted');
	} else if (!silent) {
		hud.persona.textContent = data.persona?.error || data.ibm?.error || 'Twin synced.';
		hud.persona.classList.add('muted');
	}

	hud.synced.textContent = `synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
	setStatus('');
}

// ── Live sync ─────────────────────────────────────────────────────────────────
function startSync() {
	stopSync();
	syncTimer = setInterval(() => {
		if (activeTarget && !inFlight && !document.hidden) spawn(activeTarget, { silent: true });
	}, SYNC_MS);
}
function stopSync() {
	if (syncTimer) clearInterval(syncTimer);
	syncTimer = null;
}
hud.live.addEventListener('change', () => (hud.live.checked ? startSync() : stopSync()));

// ── What-if simulator ─────────────────────────────────────────────────────────
hud.sim.shock.addEventListener('input', () => {
	const v = Number(hud.sim.shock.value);
	hud.sim.shockV.textContent = `${v > 0 ? '+' : ''}${v}%`;
});
hud.sim.vol.addEventListener('input', () => {
	hud.sim.volV.textContent = `${Number(hud.sim.vol.value).toFixed(1)}×`;
});
hud.sim.reset.addEventListener('click', () => {
	hud.sim.shock.value = 0;
	hud.sim.vol.value = 1;
	hud.sim.flip.checked = false;
	hud.sim.shockV.textContent = '0%';
	hud.sim.volV.textContent = '1.0×';
	hud.sim.out.classList.remove('show');
	clearScenario();
	if (activeTarget) spawn(activeTarget, { silent: true });
});

let simInFlight = false;
hud.sim.run.addEventListener('click', async () => {
	if (!activeTarget || simInFlight) return;
	simInFlight = true;
	hud.sim.run.disabled = true;
	const scenario = {
		priceShockPct: Number(hud.sim.shock.value),
		volatilityScale: Number(hud.sim.vol.value),
		momentumFlip: hud.sim.flip.checked,
	};
	setStatus('Running what-if on IBM Granite…', true);
	try {
		const r = await fetch('/api/ibm/twin', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...activeTarget, scenario }),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
		applyScenarioResult(data);
	} catch (e) {
		setStatus(`Scenario failed: ${e.message}`);
	} finally {
		simInFlight = false;
		hud.sim.run.disabled = false;
	}
});

function applyScenarioResult(data) {
	if (data.baseline && data.simulated) {
		renderScenario(data);
		hud.sim.base.textContent = fmtPct(data.baseline.stats.changePct, 1);
		hud.sim.sim.textContent = fmtPct(data.simulated.stats.changePct, 1);
		const d = data.divergence?.changePctDelta;
		hud.sim.delta.textContent = fmtPct(d, 1);
		hud.sim.delta.style.color =
			d > 0 ? STATE_INK.ascending : d < 0 ? STATE_INK.stressed : STATE_INK.dormant;
		hud.sim.out.classList.add('show');
	}
	const text = data.persona?.text;
	if (text) {
		hud.persona.textContent = text;
		hud.persona.classList.remove('muted');
		const dir = data.divergence?.changePctDelta ?? 0;
		narrate(text, dir >= 0 ? 'curiosity' : 'concern', Math.tanh(dir / 15));
	} else if (data.ibm && !data.ibm.configured) {
		hud.persona.textContent =
			'IBM watsonx is not configured here — the what-if simulator re-forecasts on Granite in production. The scenario shape is computed from real history.';
		hud.persona.classList.add('muted');
	}
	setStatus('');
}

// ── Wire controls ─────────────────────────────────────────────────────────────
hud.spawn.addEventListener('click', () => {
	const v = hud.search.value.trim();
	if (v) spawn({ token: v, label: v.slice(0, 6) });
});
hud.search.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') hud.spawn.click();
});

loadTrending();
startSync();
