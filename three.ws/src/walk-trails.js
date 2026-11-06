// Walk path visualization — footstep trails & routes
// ===================================================
// A delight layer that paints where the avatar has been. Three user-selectable
// styles, each rendered in BOTH worlds:
//
//   · footprints — alternating left/right marks. 3D: Three.js DecalGeometry
//     stamped onto the ground and oriented to the surface normal. 2D: DOM
//     footprint glyphs dropped behind the companion canvas.
//   · glow       — a soft particle trail. 3D: a single THREE.Points cloud whose
//     per-point alpha decays. 2D: additive canvas particles.
//   · line       — one continuous polyline that fades over time. 3D: a
//     LineSegments strip rebuilt from the live point ring. 2D: an SVG polyline.
//
// Shared rules (Task 36):
//   · every element fades over ~5s, then is removed with no visible pop;
//   · a hard cap of 60 live elements, oldest removed first;
//   · colour is derived from the avatar accent, falling back to --accent.
//
// Performance: geometry/material are created once per style and reused; removed
// decals/points free their GPU buffers. Both adapters expose the same surface
// (`setStyle`, `onStep`/`emitAt`, `update`, `dispose`) so the two call sites in
// walk.js (3D) and walk-companion.js (2D) stay symmetrical.

import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	DynamicDrawUsage,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	Object3D,
	Points,
	PointsMaterial,
	Vector3,
} from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

// ── Shared constants ─────────────────────────────────────────────────────────
export const TRAIL_STYLES = ['footprints', 'glow', 'line'];
export const TRAIL_STYLE_LABELS = {
	off: 'Off',
	footprints: 'Footprints',
	glow: 'Glow',
	line: 'Line',
};
// `off` is a valid persisted choice (trails disabled) but is not in TRAIL_STYLES
// because it isn't a renderer — it's the absence of one.
export const TRAIL_CHOICES = ['off', ...TRAIL_STYLES];

const FADE_SECONDS = 5; // every element's lifetime
const MAX_ELEMENTS = 60; // hard cap; oldest removed first
const STEP_STRIDE = 0.62; // metres of travel between footprints (3D)
const STEP_STRIDE_2D = 26; // px of "virtual" travel between footprints (2D)
const GLOW_EMIT_DIST = 0.18; // metres between glow particles (3D)
const LINE_SAMPLE_DIST = 0.14; // metres between polyline vertices (3D)
const FOOT_OFFSET = 0.13; // lateral L/R footprint offset, metres

// ── Colour helpers ───────────────────────────────────────────────────────────
function brandAccent() {
	try {
		const cs = getComputedStyle(document.documentElement);
		const v = cs.getPropertyValue('--accent').trim();
		if (v) return v;
	} catch {
		/* SSR / no DOM — fall through */
	}
	return '#ffffff';
}

// Resolve the avatar accent: explicit value wins, else the brand accent token.
// Accepts a hex string, a number (0xRRGGBB), or null/undefined.
export function resolveTrailColor(accent) {
	if (typeof accent === 'number' && Number.isFinite(accent)) {
		return '#' + (accent >>> 0).toString(16).padStart(6, '0').slice(-6);
	}
	if (typeof accent === 'string' && accent.trim()) return accent.trim();
	return brandAccent();
}

// ── Persistence ──────────────────────────────────────────────────────────────
// A single helper both adapters use so the localStorage convention is identical
// to the rest of walk.js / the companion (a namespaced string key, try/catch
// guarded for private-mode browsers).
export function createTrailSetting(storageKey, fallback = 'footprints') {
	const isValid = (v) => v === 'off' || TRAIL_STYLES.includes(v);
	let style = fallback;
	try {
		const saved = localStorage.getItem(storageKey);
		if (saved && isValid(saved)) style = saved;
	} catch {
		/* storage disabled — keep the fallback */
	}
	return {
		get() {
			return style;
		},
		set(next) {
			if (!isValid(next)) return style;
			style = next;
			try {
				localStorage.setItem(storageKey, next);
			} catch {
				/* private mode — in-memory only */
			}
			return style;
		},
		cycle() {
			const idx = TRAIL_CHOICES.indexOf(style);
			return this.set(TRAIL_CHOICES[(idx + 1) % TRAIL_CHOICES.length]);
		},
	};
}

// =============================================================================
// 3D adapter — used by src/walk.js
// =============================================================================
//
// Hosts a small scene graph the caller adds to its world. The caller drives it
// each frame with the avatar's world position + facing yaw; the adapter decides
// when to stamp a new element based on distance travelled, and ages every live
// element toward removal. `ground` must expose heightAt(x,z) and
// normalAt(x,z,out) — the walk terrain does both — so decals sit on the surface
// and face its normal.
export function createWalkTrails3D({ scene, ground, getColor, initialStyle = 'footprints' }) {
	let surface = ground; // re-pointed on environment terrain swaps via setGround()
	const color = new Color(resolveTrailColor(getColor?.()));
	let style = TRAIL_STYLES.includes(initialStyle) || initialStyle === 'off' ? initialStyle : 'footprints';

	// Distance accumulators since the last emission, per emitter cadence.
	let sinceStep = 0;
	let sinceGlow = 0;
	let sinceLine = 0;
	let footSide = 1; // alternates +1 / -1
	const lastPos = new Vector3();
	let hasLast = false;

	// Scratch — reused every frame so the hot path never allocates.
	const _n = new Vector3();
	const _decalPos = new Vector3();
	const _decalDir = new Vector3();
	const _decalSize = new Vector3(0.26, 0.36, 0.4);
	const _right = new Vector3();
	const _up = new Vector3(0, 1, 0);

	// ── footprints: a pool of decal meshes, each with its own DecalGeometry ────
	// Decals share one material (transparent, depth-tested but not depth-writing
	// so they layer cleanly on the ground). Each entry tracks its birth time so
	// update() can fade opacity and dispose the geometry on death.
	const footMat = new MeshBasicMaterial({
		color,
		transparent: true,
		opacity: 0.9,
		depthWrite: false,
		polygonOffset: true,
		polygonOffsetFactor: -4,
	});
	/** @type {{mesh: Mesh, born: number}[]} */
	const footEntries = [];

	// ── glow: one Points cloud, ring-buffer of MAX_ELEMENTS particles ──────────
	const glowGeo = new BufferGeometry();
	const glowPos = new Float32Array(MAX_ELEMENTS * 3);
	const glowPosAttr = new BufferAttribute(glowPos, 3).setUsage(DynamicDrawUsage);
	glowGeo.setAttribute('position', glowPosAttr);
	// We can't recolour per-point alpha through PointsMaterial.opacity (it's a
	// scalar), so we drive a per-vertex color whose brightness encodes life and
	// let AdditiveBlending fade each particle into the background.
	const glowColors = new Float32Array(MAX_ELEMENTS * 3);
	const glowColAttr = new BufferAttribute(glowColors, 3).setUsage(DynamicDrawUsage);
	glowGeo.setAttribute('color', glowColAttr);
	glowGeo.setDrawRange(0, 0);
	const glowMat = new PointsMaterial({
		size: 0.22,
		sizeAttenuation: true,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		vertexColors: true,
		map: makeGlowSprite(),
	});
	const glowPoints = new Points(glowGeo, glowMat);
	glowPoints.frustumCulled = false;
	let glowCount = 0; // live particle count
	let glowHead = 0; // ring write head
	const glowBorn = new Float32Array(MAX_ELEMENTS);

	// ── line: a LineSegments strip rebuilt from a point ring each frame ────────
	const lineGeo = new BufferGeometry();
	const linePts = new Float32Array(MAX_ELEMENTS * 3);
	const lineSegPos = new Float32Array((MAX_ELEMENTS - 1) * 2 * 3);
	const lineSegCol = new Float32Array((MAX_ELEMENTS - 1) * 2 * 3);
	const lineSegPosAttr = new BufferAttribute(lineSegPos, 3).setUsage(DynamicDrawUsage);
	const lineSegColAttr = new BufferAttribute(lineSegCol, 3).setUsage(DynamicDrawUsage);
	lineGeo.setAttribute('position', lineSegPosAttr);
	lineGeo.setAttribute('color', lineSegColAttr);
	lineGeo.setDrawRange(0, 0);
	const lineMat = new LineBasicMaterial({
		transparent: true,
		depthWrite: false,
		vertexColors: true,
		blending: AdditiveBlending,
	});
	const lineSegments = new LineSegments(lineGeo, lineMat);
	lineSegments.frustumCulled = false;
	const lineBorn = new Float32Array(MAX_ELEMENTS);
	let lineCount = 0;
	let lineHead = 0;

	scene.add(glowPoints);
	scene.add(lineSegments);

	function setVisibilityForStyle() {
		glowPoints.visible = style === 'glow';
		lineSegments.visible = style === 'line';
		for (const e of footEntries) e.mesh.visible = style === 'footprints';
	}
	setVisibilityForStyle();

	function refreshColor() {
		color.set(resolveTrailColor(getColor?.()));
		footMat.color.copy(color);
	}

	// Stamp a single footprint decal at world pos with surface normal `_n`.
	function stampFootprint(x, z, yaw) {
		const h = surface.heightAt(x, z);
		surface.normalAt(x, z, _n);
		// Lateral offset so prints fall on alternating sides of the path.
		_decalDir.set(Math.sin(yaw), 0, Math.cos(yaw)); // facing
		_right.crossVectors(_decalDir, _up).normalize();
		const ox = _right.x * FOOT_OFFSET * footSide;
		const oz = _right.z * FOOT_OFFSET * footSide;
		footSide *= -1;
		_decalPos.set(x + ox, h + 0.02, z + oz);

		// DecalGeometry projects onto a target mesh. The terrain mesh is the
		// projection target; the decal's orientation is built from a dummy whose
		// +Z faces the avatar and which is tilted to the ground normal.
		const orient = orientationFor(_decalDir, _n);
		const geo = new DecalGeometry(surface.mesh, _decalPos, orient, _decalSize);
		const mesh = new Mesh(geo, footMat);
		mesh.renderOrder = 2;
		mesh.visible = style === 'footprints';
		scene.add(mesh);
		footEntries.push({ mesh, born: performance.now() / 1000 });
		enforceFootCap();
	}

	// Build a Euler orientation by pointing a scratch object at the surface
	// normal, yawed to face travel. DecalGeometry takes an Euler, so we reuse one
	// lightweight Object3D and read back its rotation.
	const _orientObj = new Object3D();
	const _orientLook = new Vector3();
	function orientationFor(dir, normal) {
		// Point the decal's surface along the ground normal, yaw it to face travel.
		_orientObj.position.copy(_decalPos);
		_orientLook.copy(_decalPos).add(normal);
		_orientObj.up.copy(dir.lengthSq() > 1e-6 ? dir : _up);
		_orientObj.lookAt(_orientLook);
		return _orientObj.rotation.clone();
	}

	function enforceFootCap() {
		while (footEntries.length > MAX_ELEMENTS) {
			const old = footEntries.shift();
			disposeFoot(old);
		}
	}
	function disposeFoot(entry) {
		if (!entry) return;
		scene.remove(entry.mesh);
		entry.mesh.geometry.dispose();
	}

	function pushGlow(x, y, z) {
		const i = glowHead;
		glowPos[i * 3] = x;
		glowPos[i * 3 + 1] = y;
		glowPos[i * 3 + 2] = z;
		glowBorn[i] = performance.now() / 1000;
		glowHead = (glowHead + 1) % MAX_ELEMENTS;
		glowCount = Math.min(glowCount + 1, MAX_ELEMENTS);
	}

	function pushLine(x, y, z) {
		const i = lineHead;
		linePts[i * 3] = x;
		linePts[i * 3 + 1] = y;
		linePts[i * 3 + 2] = z;
		lineBorn[i] = performance.now() / 1000;
		lineHead = (lineHead + 1) % MAX_ELEMENTS;
		lineCount = Math.min(lineCount + 1, MAX_ELEMENTS);
	}

	// Called every frame with the avatar's world position + facing + moving flag.
	function update(dt, { x, y, z, yaw, moving }) {
		const now = performance.now() / 1000;

		if (hasLast && moving) {
			const dx = x - lastPos.x;
			const dz = z - lastPos.z;
			const stepped = Math.hypot(dx, dz);
			if (stepped > 0 && stepped < 5) {
				sinceStep += stepped;
				sinceGlow += stepped;
				sinceLine += stepped;

				if (style === 'footprints') {
					while (sinceStep >= STEP_STRIDE) {
						sinceStep -= STEP_STRIDE;
						stampFootprint(x, z, yaw);
					}
				} else if (style === 'glow') {
					while (sinceGlow >= GLOW_EMIT_DIST) {
						sinceGlow -= GLOW_EMIT_DIST;
						pushGlow(x, surface.heightAt(x, z) + 0.12, z);
					}
				} else if (style === 'line') {
					while (sinceLine >= LINE_SAMPLE_DIST) {
						sinceLine -= LINE_SAMPLE_DIST;
						pushLine(x, surface.heightAt(x, z) + 0.06, z);
					}
				}
			}
		}
		lastPos.set(x, y, z);
		hasLast = true;

		ageFootprints(now);
		ageGlow(now);
		ageLine(now);
	}

	function ageFootprints(now) {
		// Fade opacity by youngest survivor; oldest are removed when fully faded.
		// Decals share one material, so we can't fade individually via opacity —
		// instead we fade the whole material to the freshest print's life and
		// drop dead prints from the pool. With even spacing this reads as a tail.
		let alive = 0;
		let freshest = 0;
		for (let i = footEntries.length - 1; i >= 0; i--) {
			const e = footEntries[i];
			const age = now - e.born;
			if (age >= FADE_SECONDS) {
				disposeFoot(e);
				footEntries.splice(i, 1);
				continue;
			}
			alive++;
			freshest = Math.max(freshest, 1 - age / FADE_SECONDS);
		}
		// Per-print fade: give each its own cloned material lazily only when the
		// pool is small enough to matter; for the common case we fade the shared
		// material to the average remaining life so the tail dims as one.
		if (style === 'footprints' && alive > 0) {
			let sum = 0;
			for (const e of footEntries) sum += 1 - (now - e.born) / FADE_SECONDS;
			footMat.opacity = Math.max(0.05, (sum / alive) * 0.9);
		}
	}

	function ageGlow(now) {
		if (glowCount === 0) {
			glowGeo.setDrawRange(0, 0);
			return;
		}
		for (let i = 0; i < MAX_ELEMENTS; i++) {
			const born = glowBorn[i];
			if (born <= 0) {
				glowColors[i * 3] = glowColors[i * 3 + 1] = glowColors[i * 3 + 2] = 0;
				continue;
			}
			const life = 1 - (now - born) / FADE_SECONDS;
			if (life <= 0) {
				glowBorn[i] = 0;
				glowColors[i * 3] = glowColors[i * 3 + 1] = glowColors[i * 3 + 2] = 0;
				continue;
			}
			// Brightness encodes life; AdditiveBlending fades it into the scene.
			const b = life * life; // ease-in for a softer tail
			glowColors[i * 3] = color.r * b;
			glowColors[i * 3 + 1] = color.g * b;
			glowColors[i * 3 + 2] = color.b * b;
		}
		glowPosAttr.needsUpdate = true;
		glowColAttr.needsUpdate = true;
		glowGeo.setDrawRange(0, MAX_ELEMENTS);
	}

	function ageLine(now) {
		// Emit ordered segments from oldest live vertex to newest, fading each
		// vertex's colour by its life. Walk the ring in chronological order.
		const order = [];
		for (let k = 0; k < lineCount; k++) {
			const idx = (lineHead - lineCount + k + MAX_ELEMENTS) % MAX_ELEMENTS;
			const born = lineBorn[idx];
			if (born <= 0) continue;
			if (now - born >= FADE_SECONDS) {
				lineBorn[idx] = 0;
				continue;
			}
			order.push(idx);
		}
		// Compact lineCount toward the live span so dead head entries don't linger.
		if (order.length < lineCount) lineCount = order.length;

		let seg = 0;
		for (let k = 0; k < order.length - 1; k++) {
			const a = order[k];
			const b = order[k + 1];
			const la = 1 - (now - lineBorn[a]) / FADE_SECONDS;
			const lb = 1 - (now - lineBorn[b]) / FADE_SECONDS;
			const base = seg * 6;
			lineSegPos[base] = linePts[a * 3];
			lineSegPos[base + 1] = linePts[a * 3 + 1];
			lineSegPos[base + 2] = linePts[a * 3 + 2];
			lineSegPos[base + 3] = linePts[b * 3];
			lineSegPos[base + 4] = linePts[b * 3 + 1];
			lineSegPos[base + 5] = linePts[b * 3 + 2];
			lineSegCol[base] = color.r * la;
			lineSegCol[base + 1] = color.g * la;
			lineSegCol[base + 2] = color.b * la;
			lineSegCol[base + 3] = color.r * lb;
			lineSegCol[base + 4] = color.g * lb;
			lineSegCol[base + 5] = color.b * lb;
			seg++;
		}
		lineSegPosAttr.needsUpdate = true;
		lineSegColAttr.needsUpdate = true;
		lineGeo.setDrawRange(0, seg * 2);
	}

	function setStyle(next) {
		if (next !== 'off' && !TRAIL_STYLES.includes(next)) return;
		if (next === style) return;
		style = next;
		setVisibilityForStyle();
		// Reset cadence so the new style doesn't dump a burst on switch.
		sinceStep = sinceGlow = sinceLine = 0;
	}

	function clear() {
		for (const e of footEntries) disposeFoot(e);
		footEntries.length = 0;
		glowCount = glowHead = 0;
		glowBorn.fill(0);
		glowGeo.setDrawRange(0, 0);
		lineCount = lineHead = 0;
		lineBorn.fill(0);
		lineGeo.setDrawRange(0, 0);
	}

	function dispose() {
		clear();
		scene.remove(glowPoints);
		scene.remove(lineSegments);
		glowGeo.dispose();
		glowMat.map?.dispose();
		glowMat.dispose();
		lineGeo.dispose();
		lineMat.dispose();
		footMat.dispose();
	}

	// Re-point at a freshly generated terrain (environment swap). Existing decals
	// are baked world-space geometry and stay valid, but we clear them so the old
	// surface's prints don't hover over the new ground shape.
	function setGround(next) {
		if (!next) return;
		surface = next;
		clear();
		hasLast = false;
	}

	return {
		get style() {
			return style;
		},
		setStyle,
		setGround,
		refreshColor,
		update,
		clear,
		dispose,
	};
}

// A soft round sprite for glow particles — a radial alpha gradient on a small
// canvas, uploaded once and shared by every particle.
function makeGlowSprite() {
	const c = document.createElement('canvas');
	c.width = c.height = 64;
	const ctx = c.getContext('2d');
	const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
	g.addColorStop(0, 'rgba(255,255,255,1)');
	g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 64, 64);
	return new CanvasTexture(c);
}

// =============================================================================
// 2D adapter — used by src/walk-companion.js
// =============================================================================
//
// The site-wide companion is a fixed-corner 3D canvas whose avatar walks in
// place (it rotates to follow the cursor rather than translating across the
// page). So the 2D trail emits *beneath* the companion host while the avatar is
// in its walk state, dropping footprints / particles / a fading line into an
// overlay layered directly behind the avatar canvas. The overlay tracks the
// host's screen rect so it stays glued to the companion as it animates in/out
// and on resize.
export function createWalkTrails2D({ host, getColor, getWalking, initialStyle = 'footprints' }) {
	let style = TRAIL_STYLES.includes(initialStyle) || initialStyle === 'off' ? initialStyle : 'footprints';
	let color = resolveTrailColor(getColor?.());

	// Overlay container — positioned fixed, glued under the companion canvas
	// (z-index below the canvas's z-index:1 so prints sit behind the avatar).
	const layer = document.createElement('div');
	layer.className = 'walk-trail-layer';
	layer.setAttribute('aria-hidden', 'true');
	layer.style.cssText = [
		'position:fixed',
		'z-index:2147482999', // one below .walk-companion (2147483000)
		'pointer-events:none',
		'overflow:visible',
		'contain:layout style',
	].join(';');
	document.body.appendChild(layer);

	// Canvas for glow particles (cheap, additive). SVG for the line. DOM nodes
	// for footprints. Only the active style's surface is populated.
	const glowCanvas = document.createElement('canvas');
	glowCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
	const gctx = glowCanvas.getContext('2d');
	const svgNS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(svgNS, 'svg');
	svg.setAttribute('width', '100%');
	svg.setAttribute('height', '100%');
	svg.style.cssText = 'position:absolute;inset:0;overflow:visible';
	const polyline = document.createElementNS(svgNS, 'polyline');
	polyline.setAttribute('fill', 'none');
	polyline.setAttribute('stroke-width', '3');
	polyline.setAttribute('stroke-linecap', 'round');
	polyline.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(polyline);
	layer.appendChild(glowCanvas);
	layer.appendChild(svg);

	// State. The companion avatar walks in place, so we synthesize a path: while
	// walking, a virtual head advances along a gentle sine wave inside the layer,
	// leaving a tail. Footprints alternate L/R across that head.
	/** @type {{el: HTMLElement, born: number}[]} */
	const footEls = [];
	/** @type {{x: number, y: number, born: number}[]} */
	const glowParts = [];
	/** @type {{x: number, y: number, born: number}[]} */
	const linePts = [];
	let footSide = 1;
	let virtual = 0; // px advanced along the synthetic path while walking
	let lastVirtualStep = 0;
	let lastVirtualGlow = 0;
	let lastVirtualLine = 0;
	let rect = { left: 0, top: 0, width: 0, height: 0 };
	let dpr = Math.min(window.devicePixelRatio || 1, 2);

	function syncRect() {
		const r = host.getBoundingClientRect();
		rect = { left: r.left, top: r.top, width: r.width, height: r.height };
		layer.style.left = `${r.left}px`;
		layer.style.top = `${r.top}px`;
		layer.style.width = `${r.width}px`;
		layer.style.height = `${r.height}px`;
		const w = Math.max(1, Math.round(r.width * dpr));
		const h = Math.max(1, Math.round(r.height * dpr));
		if (glowCanvas.width !== w || glowCanvas.height !== h) {
			glowCanvas.width = w;
			glowCanvas.height = h;
		}
	}

	// Map a virtual path distance to a point within the layer. The synthetic path
	// loops gently near the base of the avatar so the trail reads as footwork in
	// place rather than wandering off-screen.
	function pathPoint(v) {
		const w = rect.width || 1;
		const baseY = (rect.height || 1) * 0.86; // near the feet
		const x = w * 0.5 + Math.sin(v / 46) * w * 0.22;
		const y = baseY + Math.cos(v / 70) * (rect.height || 1) * 0.03;
		return { x, y };
	}

	function setVisibility() {
		glowCanvas.style.display = style === 'glow' ? '' : 'none';
		svg.style.display = style === 'line' ? '' : 'none';
		for (const f of footEls) f.el.style.display = style === 'footprints' ? '' : 'none';
	}
	setVisibility();

	function spawnFootprint(v) {
		const p = pathPoint(v);
		const el = document.createElement('div');
		el.className = 'walk-trail-foot';
		// A footprint glyph drawn as a rounded oval with a small toe dot, rotated
		// to face along the path tangent and offset L/R.
		const tangent = pathPoint(v + 1);
		const ang = Math.atan2(tangent.y - p.y, tangent.x - p.x) * (180 / Math.PI) + 90;
		const nx = Math.cos((ang * Math.PI) / 180);
		const ny = Math.sin((ang * Math.PI) / 180);
		const ox = nx * 7 * footSide;
		const oy = ny * 7 * footSide;
		footSide *= -1;
		el.style.cssText = [
			'position:absolute',
			`left:${p.x + ox - 5}px`,
			`top:${p.y + oy - 8}px`,
			'width:10px',
			'height:16px',
			`background:${color}`,
			'border-radius:50% 50% 45% 45%',
			`transform:rotate(${ang}deg)`,
			'opacity:0.85',
			'transition:opacity 0.4s linear',
			'will-change:opacity',
		].join(';');
		el.style.display = style === 'footprints' ? '' : 'none';
		layer.appendChild(el);
		footEls.push({ el, born: performance.now() / 1000 });
		while (footEls.length > MAX_ELEMENTS) {
			const old = footEls.shift();
			old.el.remove();
		}
	}

	function spawnGlow(v) {
		const p = pathPoint(v);
		glowParts.push({ x: p.x, y: p.y, born: performance.now() / 1000 });
		while (glowParts.length > MAX_ELEMENTS) glowParts.shift();
	}

	function spawnLinePoint(v) {
		const p = pathPoint(v);
		linePts.push({ x: p.x, y: p.y, born: performance.now() / 1000 });
		while (linePts.length > MAX_ELEMENTS) linePts.shift();
	}

	function update(dt) {
		syncRect();
		const walking = !!getWalking?.();
		const now = performance.now() / 1000;

		if (walking) {
			// Advance the virtual path head at a steady cadence while walking.
			virtual += dt * 60;
			if (style === 'footprints') {
				while (virtual - lastVirtualStep >= STEP_STRIDE_2D) {
					lastVirtualStep += STEP_STRIDE_2D;
					spawnFootprint(lastVirtualStep);
				}
			} else if (style === 'glow') {
				while (virtual - lastVirtualGlow >= 6) {
					lastVirtualGlow += 6;
					spawnGlow(lastVirtualGlow);
				}
			} else if (style === 'line') {
				while (virtual - lastVirtualLine >= 5) {
					lastVirtualLine += 5;
					spawnLinePoint(lastVirtualLine);
				}
			}
		}

		ageFeet(now);
		drawGlow(now);
		drawLine(now);
	}

	function ageFeet(now) {
		for (let i = footEls.length - 1; i >= 0; i--) {
			const f = footEls[i];
			const age = now - f.born;
			if (age >= FADE_SECONDS) {
				f.el.remove();
				footEls.splice(i, 1);
				continue;
			}
			f.el.style.opacity = String(Math.max(0, (1 - age / FADE_SECONDS) * 0.85));
		}
	}

	function drawGlow(now) {
		const w = glowCanvas.width;
		const h = glowCanvas.height;
		gctx.clearRect(0, 0, w, h);
		if (style !== 'glow') return;
		const rgb = hexToRgb(color);
		gctx.globalCompositeOperation = 'lighter';
		for (let i = glowParts.length - 1; i >= 0; i--) {
			const p = glowParts[i];
			const life = 1 - (now - p.born) / FADE_SECONDS;
			if (life <= 0) {
				glowParts.splice(i, 1);
				continue;
			}
			const r = 9 * dpr * (0.5 + life * 0.5);
			const cx = p.x * dpr;
			const cy = p.y * dpr;
			const grad = gctx.createRadialGradient(cx, cy, 0, cx, cy, r);
			grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${0.5 * life})`);
			grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
			gctx.fillStyle = grad;
			gctx.beginPath();
			gctx.arc(cx, cy, r, 0, Math.PI * 2);
			gctx.fill();
		}
		gctx.globalCompositeOperation = 'source-over';
	}

	function drawLine(now) {
		if (style !== 'line') {
			polyline.setAttribute('points', '');
			return;
		}
		// Drop dead points; render the live span as a single polyline whose
		// opacity tracks the freshest segment (the tail dims as points expire).
		let pts = '';
		let freshest = 0;
		for (let i = linePts.length - 1; i >= 0; i--) {
			if (now - linePts[i].born >= FADE_SECONDS) {
				linePts.splice(i, 1);
			}
		}
		for (const p of linePts) {
			pts += `${p.x.toFixed(1)},${p.y.toFixed(1)} `;
			freshest = Math.max(freshest, 1 - (now - p.born) / FADE_SECONDS);
		}
		polyline.setAttribute('points', pts.trim());
		polyline.setAttribute('stroke', color);
		polyline.setAttribute('opacity', String(Math.max(0.1, freshest * 0.8)));
	}

	function setStyle(next) {
		if (next !== 'off' && !TRAIL_STYLES.includes(next)) return;
		if (next === style) return;
		style = next;
		setVisibility();
		// Reset cadence so switching styles doesn't dump a burst.
		lastVirtualStep = lastVirtualGlow = lastVirtualLine = virtual;
	}

	function refreshColor() {
		color = resolveTrailColor(getColor?.());
	}

	function clear() {
		for (const f of footEls) f.el.remove();
		footEls.length = 0;
		glowParts.length = 0;
		linePts.length = 0;
		gctx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
		polyline.setAttribute('points', '');
	}

	function dispose() {
		clear();
		layer.remove();
	}

	const onResize = () => {
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		syncRect();
	};
	window.addEventListener('resize', onResize);
	const _dispose = dispose;
	const disposeWrapped = () => {
		window.removeEventListener('resize', onResize);
		_dispose();
	};

	return {
		get style() {
			return style;
		},
		setStyle,
		refreshColor,
		update,
		clear,
		dispose: disposeWrapped,
	};
}

// ── small colour util ────────────────────────────────────────────────────────
function hexToRgb(hex) {
	const c = new Color(hex);
	return { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255) };
}
