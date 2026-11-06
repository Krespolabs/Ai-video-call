// Granite Oracle — the 3D forecast scene.
//
// Pulls a live Solana token's candles + an IBM Granite TimeSeries forecast from
// /api/ibm/oracle, renders the history as a neon price ribbon and the forecast
// as a glowing cone that sweeps forward, and lets the embodied <agent-3d> avatar
// narrate the Granite analysis (governed by Granite Guardian). All data is real.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const IBM = {
	blue: 0x0f62fe,
	blueLight: 0x78a9ff,
	up: 0x42be65,
	down: 0xfa4d56,
	flat: 0x8d8d8d,
	white: 0xf4f4f4,
};
const SPAN = 12; // world-units across the time axis
const HEIGHT = 5.5; // world-units across the price axis

// ── DOM handles ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const stage = $('oracle-stage');
const hud = {
	name: $('o-name'),
	price: $('o-price'),
	change: $('o-change'),
	horizon: $('o-horizon'),
	band: $('o-band'),
	forecastBadge: $('o-forecast-badge'),
	govBadge: $('o-gov-badge'),
	narration: $('o-narration'),
	status: $('o-status'),
	chips: $('o-chips'),
	search: $('o-search'),
	run: $('o-run'),
};

// ── Three.js scaffold ───────────────────────────────────────────────────────
// Build the WebGL renderer defensively. On a device without WebGL the
// constructor throws — so instead of crashing the whole page (and losing the
// Granite narration + numeric readout, which don't need 3D) we show an inline
// note and hand back an inert stub the scene code below can call harmlessly.
function makeRenderer() {
	try {
		const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		r.setSize(stage.clientWidth, stage.clientHeight);
		r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		r.localClippingEnabled = true;
		stage.appendChild(r.domElement);
		r.ok = true;
		return r;
	} catch {
		const note = document.createElement('div');
		note.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center';
		note.innerHTML =
			'<p style="max-width:34ch;margin:0;color:#8a93a6;font:14px/1.5 system-ui,sans-serif">Live 3D forecast needs WebGL, which isn’t available on this device. The Granite narration and numeric readout below still work.</p>';
		stage.appendChild(note);
		return { ok: false, domElement: document.createElement('canvas'), setSize() {}, setPixelRatio() {}, render() {}, dispose() {} };
	}
}
const renderer = makeRenderer();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, stage.clientWidth / stage.clientHeight, 0.1, 200);
camera.position.set(0, 2.2, SPAN * 0.92);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
// Respect the OS "reduce motion" setting: no idle camera spin (and no forecast
// sweep — see renderSeries). Users who opt out of motion get a static scene.
const reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = 0.5;
controls.minDistance = 6;
controls.maxDistance = 22;
controls.maxPolarAngle = Math.PI * 0.62;

// Floor grid
const grid = new THREE.GridHelper(SPAN * 1.5, 30, IBM.blue, 0x1b2436);
grid.position.y = -HEIGHT / 2 - 0.8;
grid.material.transparent = true;
grid.material.opacity = 0.32;
scene.add(grid);

// Ambient particle field
const particles = (() => {
	const n = 360;
	const geo = new THREE.BufferGeometry();
	const pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		pos[i * 3] = (Math.random() - 0.5) * SPAN * 1.6;
		pos[i * 3 + 1] = (Math.random() - 0.5) * HEIGHT * 2;
		pos[i * 3 + 2] = (Math.random() - 0.5) * SPAN * 0.8;
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

// The reveal clipping plane: forecast geometry is clipped to x ≤ revealX, which
// we sweep from the "now" seam to the far edge so the cone draws on.
const revealPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), SPAN / 2);
let revealStart = 0;
let revealing = false;

// A group we rebuild on every forecast.
let seriesGroup = new THREE.Group();
scene.add(seriesGroup);

function disposeGroup(g) {
	g.traverse((o) => {
		if (o.geometry) o.geometry.dispose();
		if (o.material)
			(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
	});
	scene.remove(g);
}

function glowTube(points, color, radius, opacity = 1) {
	const curve = new THREE.CatmullRomCurve3(points);
	const geo = new THREE.TubeGeometry(curve, Math.min(600, points.length * 4), radius, 8, false);
	const core = new THREE.Mesh(
		geo,
		new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
	);
	const halo = new THREE.Mesh(
		new THREE.TubeGeometry(curve, Math.min(600, points.length * 4), radius * 2.6, 8, false),
		new THREE.MeshBasicMaterial({
			color,
			transparent: true,
			opacity: opacity * 0.16,
			depthWrite: false,
		}),
	);
	const grp = new THREE.Group();
	grp.add(core, halo);
	return grp;
}

function marker(pos, color, r = 0.13) {
	const m = new THREE.Mesh(
		new THREE.SphereGeometry(r, 20, 20),
		new THREE.MeshBasicMaterial({ color }),
	);
	m.position.copy(pos);
	const halo = new THREE.Mesh(
		new THREE.SphereGeometry(r * 2.4, 20, 20),
		new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }),
	);
	m.add(halo);
	return m;
}

// Downsample a {t,c} series to at most `max` points (keeps first & last).
function downsample(arr, max) {
	if (arr.length <= max) return arr;
	const step = (arr.length - 1) / (max - 1);
	const out = [];
	for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
	return out;
}

// Build the whole series visualization from the API payload.
function renderSeries(data) {
	disposeGroup(seriesGroup);
	seriesGroup = new THREE.Group();
	scene.add(seriesGroup);

	const history = downsample(data.history, 160);
	const forecast = data.forecast || [];
	const all = [...history, ...forecast].map((p) => p.c).filter(Number.isFinite);
	const min = Math.min(...all);
	const max = Math.max(...all);
	const tMin = history[0].t;
	const tMax = forecast.length ? forecast[forecast.length - 1].t : history[history.length - 1].t;
	const span = Math.max(1, tMax - tMin);
	const xOf = (t) => ((t - tMin) / span) * SPAN - SPAN / 2;
	const yOf = (c) => (max === min ? 0 : ((c - min) / (max - min)) * HEIGHT - HEIGHT / 2);

	const histPts = history.map((p) => new THREE.Vector3(xOf(p.t), yOf(p.c), 0));
	seriesGroup.add(glowTube(histPts, IBM.blueLight, 0.035));

	// "Now" seam
	const seam = histPts[histPts.length - 1];
	const seamLine = new THREE.Mesh(
		new THREE.PlaneGeometry(0.012, HEIGHT * 1.05),
		new THREE.MeshBasicMaterial({
			color: IBM.white,
			transparent: true,
			opacity: 0.28,
			side: THREE.DoubleSide,
		}),
	);
	seamLine.position.set(seam.x, 0, 0);
	seriesGroup.add(seamLine);
	seriesGroup.add(marker(seam, IBM.white, 0.11));

	let direction = 'flat';
	if (forecast.length && data.stats) {
		direction = data.stats.direction;
		const dirColor = direction === 'up' ? IBM.up : direction === 'down' ? IBM.down : IBM.flat;

		const fPts = [seam, ...forecast.map((p) => new THREE.Vector3(xOf(p.t), yOf(p.c), 0))];
		const fTube = glowTube(fPts, dirColor, 0.045);

		// Uncertainty ribbon: half-band grows 0 → (high-low)/2 across the horizon.
		const halfMax = Math.max(
			0.06,
			(yOf(data.stats.forecastHigh) - yOf(data.stats.forecastLow)) / 2,
		);
		const ribGeo = new THREE.BufferGeometry();
		const verts = [];
		for (let i = 0; i < fPts.length; i++) {
			const f = i / (fPts.length - 1);
			const hb = halfMax * f;
			verts.push(fPts[i].x, fPts[i].y + hb, 0, fPts[i].x, fPts[i].y - hb, 0);
		}
		ribGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
		const idx = [];
		for (let i = 0; i < fPts.length - 1; i++) {
			const a = i * 2;
			idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
		}
		ribGeo.setIndex(idx);
		const ribbon = new THREE.Mesh(
			ribGeo,
			new THREE.MeshBasicMaterial({
				color: dirColor,
				transparent: true,
				opacity: 0.16,
				side: THREE.DoubleSide,
				depthWrite: false,
			}),
		);

		const endMarker = marker(fPts[fPts.length - 1], dirColor, 0.15);

		// Clip the forecast group so it can sweep in from the seam.
		const fGroup = new THREE.Group();
		fGroup.add(fTube, ribbon, endMarker);
		fGroup.traverse((o) => {
			if (o.material)
				(Array.isArray(o.material) ? o.material : [o.material]).forEach(
					(m) => (m.clippingPlanes = [revealPlane]),
				);
		});
		seriesGroup.add(fGroup);

		// Kick off the reveal sweep from the seam — unless the user prefers
		// reduced motion, in which case the forecast is shown fully, immediately.
		seriesGroup.userData.revealTo = SPAN / 2 + 0.5;
		seriesGroup.userData.seamX = seam.x;
		if (reduceMotion) {
			revealPlane.constant = seriesGroup.userData.revealTo;
			revealing = false;
		} else {
			revealPlane.constant = -seam.x; // x ≤ seam.x visible
			revealStart = performance.now();
			revealing = true;
		}
	}

	// Frame the camera target on the curve midpoint height.
	controls.target.set(0, 0, 0);
}

// ── Animation loop ──────────────────────────────────────────────────────────
let running = true;
function animate() {
	if (!running || !renderer.ok) return;
	requestAnimationFrame(animate);
	const t = performance.now();
	controls.update();
	particles.rotation.y += 0.0008;

	if (revealing) {
		const p = Math.min(1, (t - revealStart) / 1200);
		const seamX = seriesGroup.userData.seamX ?? -SPAN / 2;
		const to = seriesGroup.userData.revealTo ?? SPAN / 2;
		revealPlane.constant = -(seamX + (to - seamX) * easeOut(p));
		if (p >= 1) revealing = false;
	}
	renderer.render(scene, camera);
}
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

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

// ── Embodied narrator (optional, graceful) ──────────────────────────────────
const avatar = document.querySelector('agent-3d');
let avatarReady = false;

// Pulse the narration bar while the avatar is actually speaking. Driven by the
// avatar's real voice events when available, with a length-based safety net so
// the indicator never sticks on if no end event fires.
const narrationBar = document.querySelector('.narration-bar');
let speakingTimer = null;
function setSpeaking(on, text = '') {
	narrationBar?.classList.toggle('speaking', on);
	clearTimeout(speakingTimer);
	if (on) {
		speakingTimer = setTimeout(
			() => narrationBar?.classList.remove('speaking'),
			Math.min(14000, 2200 + text.length * 55),
		);
	}
}

if (avatar) {
	avatar.addEventListener('agent:ready', () => (avatarReady = true));
	avatar.addEventListener('agent:error', () => (avatarReady = false));
	avatar.addEventListener('voice:speech-start', () => setSpeaking(true));
	avatar.addEventListener('voice:speech-end', () => setSpeaking(false));
}
function narrate(text, emotion, sentiment) {
	if (!text) return;
	setSpeaking(true, text);
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
		u.rate = 1;
		u.pitch = 1;
		u.onend = () => setSpeaking(false);
		u.onerror = () => setSpeaking(false);
		window.speechSynthesis.speak(u);
	} catch {
		setSpeaking(false);
	}
}

// ── Data + HUD ──────────────────────────────────────────────────────────────
const fmtPrice = (p) => {
	if (!Number.isFinite(p)) return '—';
	if (p >= 1) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
	return `$${p.toPrecision(4)}`;
};
const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;

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
	hud.run.disabled = busy;
}

async function loadTrending() {
	try {
		const r = await fetch('/api/ibm/oracle?list=trending');
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		hud.chips.innerHTML = '';
		(j.pools || []).forEach((p) => {
			const chip = document.createElement('button');
			chip.className = 'o-chip';
			chip.textContent = p.name;
			chip.title = `${p.name} · ${p.priceUsd != null ? fmtPrice(p.priceUsd) : ''}`;
			chip.addEventListener('click', () => runForecast({ pool: p.pool, label: p.name }));
			hud.chips.appendChild(chip);
		});
		// Auto-run the top trending pool so the scene is never empty.
		if (j.pools?.[0]) runForecast({ pool: j.pools[0].pool, label: j.pools[0].name });
	} catch (e) {
		setStatus(`Could not load trending tokens: ${e.message}`, false, loadTrending);
	}
}

let inFlight = false;
async function runForecast({ pool, token, label }) {
	if (inFlight) return;
	inFlight = true;
	setStatus(`Querying IBM Granite for ${label || token || 'token'}…`, true);
	try {
		const q = pool ? `pool=${encodeURIComponent(pool)}` : `token=${encodeURIComponent(token)}`;
		const r = await fetch(`/api/ibm/oracle?${q}`);
		const data = await r.json();
		if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
		applyData(data);
	} catch (e) {
		const target = { pool, token, label };
		setStatus(`Forecast failed: ${e.message}`, false, () => runForecast(target));
	} finally {
		inFlight = false;
	}
}

function applyData(data) {
	renderSeries(data);
	const tk = data.token || {};
	hud.name.textContent = tk.symbol ? `${tk.name} · ${tk.symbol}` : tk.name || 'Token';

	// Deep-link the "Notarize on-chain" CTA to Granite Proof for this same pool,
	// so a forecast you like can be stamped on-chain in one hop.
	const notarize = document.getElementById('o-notarize');
	if (notarize && tk.pool) {
		notarize.href = `/ibm/proof?pool=${encodeURIComponent(tk.pool)}`;
	}

	const current = data.stats?.currentPrice ?? data.history?.[data.history.length - 1]?.c;
	hud.price.textContent = fmtPrice(current);

	if (data.stats) {
		hud.change.textContent = fmtPct(data.stats.changePct);
		hud.change.className =
			'o-change ' +
			(data.stats.direction === 'down'
				? 'down'
				: data.stats.direction === 'up'
					? 'up'
					: 'flat');
		hud.horizon.textContent = `${data.stats.horizonHours}h horizon`;
		hud.band.textContent = `${fmtPrice(data.stats.forecastLow)} – ${fmtPrice(data.stats.forecastHigh)}`;
	} else {
		hud.change.textContent = '—';
		hud.change.className = 'o-change flat';
		hud.horizon.textContent = '';
		hud.band.textContent = '';
	}

	// IBM badges
	if (data.ibm?.configured && data.ibm.forecastModel) {
		hud.forecastBadge.hidden = false;
		hud.forecastBadge.querySelector('.o-badge-sub').textContent = data.ibm.forecastModel;
	} else {
		hud.forecastBadge.hidden = false;
		hud.forecastBadge.querySelector('.o-badge-sub').textContent =
			data.ibm?.error || data.ibm?.reason || 'forecast unavailable';
	}

	if (data.governance) {
		hud.govBadge.hidden = false;
		const pass = data.governance.passed;
		hud.govBadge.classList.toggle('fail', pass === false);
		hud.govBadge.querySelector('.o-badge-sub').textContent =
			pass === true
				? `PASS · ${data.governance.risk}`
				: pass === false
					? `FLAGGED · ${data.governance.risk}`
					: 'checked';
	} else {
		hud.govBadge.hidden = true;
	}

	// Narration
	const text = data.narration?.text;
	if (text) {
		hud.narration.textContent = text;
		hud.narration.classList.remove('muted');
		narrate(text, data.mood?.emotion, data.mood?.sentiment);
	} else if (data.ibm && !data.ibm.configured) {
		hud.narration.textContent =
			'Live Granite forecasting activates once IBM watsonx credentials (WATSONX_API_KEY + WATSONX_PROJECT_ID) are set on this deployment. The chart above is real on-chain price history.';
		hud.narration.classList.add('muted');
	} else {
		hud.narration.textContent =
			data.narration?.error || data.ibm?.error || 'Forecast complete.';
		hud.narration.classList.add('muted');
	}

	setStatus('');
}

// ── Wire controls ───────────────────────────────────────────────────────────
hud.run.addEventListener('click', () => {
	const v = hud.search.value.trim();
	if (v) runForecast({ token: v, label: v.slice(0, 6) });
});
hud.search.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') hud.run.click();
});

loadTrending();
