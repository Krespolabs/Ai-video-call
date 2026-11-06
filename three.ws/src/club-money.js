// /club money: the $0.001 bills that land on the stages.
//
// Every tip is real USDC, so the room should show money moving. A tip you pay
// is thrown: a clump of bills leaves the camera, arcs over the floor and
// flutters down onto that dancer's stage. Someone else's tip, arriving live
// over the tips stream, drops out of the rig above the pole instead. Bills
// that land stay where they fell, so each stage keeps a pile for the night,
// seeded on boot from that dancer's real tip count.
//
// One InstancedMesh draws every bill (one draw call however many are in the
// air). Slots are recycled oldest-resting-first once the device's budget is
// full, so a busy night never grows the scene. The bill face is drawn once to
// a canvas texture: no image asset, no network fetch.
//
// Tips paid from a platform wallet (the x402 ring and roster agents, flagged
// `agent` by /api/club/tips) print on a violet bill, so agent money is never
// passed off as a person's.

import {
	CanvasTexture,
	Color,
	DoubleSide,
	DynamicDrawUsage,
	Euler,
	InstancedBufferAttribute,
	InstancedMesh,
	Matrix4,
	MeshStandardMaterial,
	PlaneGeometry,
	Quaternion,
	SRGBColorSpace,
	Vector3,
} from 'three';

// A real banknote is ~156 x 66 mm; the bill keeps that proportion.
const BILL_W = 0.16;
const BILL_H = 0.068;

const GRAVITY = -9.8;
const TERMINAL_FALL = -0.75;   // m/s once a bill is fluttering, paper-slow
const FLUTTER_BELOW_VY = -0.6; // a thrown bill starts to flutter once it is falling this fast
const THROW_FLIGHT_SEC = 0.9;
const DROP_HEIGHT = 3.4;       // how far above the stage a dropped bill starts
const REST_LIFT = 0.0015;      // clears the stage top so a flat bill never z-fights
const STACK_STEP = 0.0007;     // each landed bill sits a hair above the last
const STACK_MAX = 0.035;

const STATE_FREE = 0;
const STATE_THROWN = 1;
const STATE_FLUTTER = 2;
const STATE_REST = 3;

const HUMAN_TINT = new Color(1, 1, 1);
const AGENT_TINT = new Color(0.78, 0.66, 1.0);

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const ZERO_SCALE = new Matrix4().makeScale(0, 0, 0);

/**
 * Initial velocity that carries a body from `from` to `to` in `t` seconds under
 * gravity alone. Pure, so the throw arc is unit-testable.
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 * @param {number} t
 */
export function ballisticVelocity(from, to, t) {
	return {
		x: (to.x - from.x) / t,
		y: (to.y - from.y) / t - 0.5 * GRAVITY * t,
		z: (to.z - from.z) / t,
	};
}

/**
 * A random point on a stage disc, kept off the pole in the middle and inside
 * the rim so a landed bill reads as lying on the stage.
 * @param {{x:number,z:number,radius:number}} stage
 * @param {() => number} rng
 */
export function pointOnStage(stage, rng) {
	const inner = 0.16;
	const outer = Math.max(inner + 0.05, stage.radius - 0.12);
	// sqrt keeps the scatter even across the disc instead of bunching at the pole
	const r = Math.sqrt(inner * inner + rng() * (outer * outer - inner * inner));
	const a = rng() * Math.PI * 2;
	return { x: stage.x + Math.cos(a) * r, z: stage.z + Math.sin(a) * r };
}

/** Draw the bill face once. Big denomination, USDC blue, three.ws mark. */
function drawBillTexture() {
	const c = document.createElement('canvas');
	c.width = 512;
	c.height = 218;
	const g = c.getContext('2d');
	const grad = g.createLinearGradient(0, 0, c.width, c.height);
	grad.addColorStop(0, '#2d7fd6');
	grad.addColorStop(0.55, '#2263ad');
	grad.addColorStop(1, '#173f78');
	g.fillStyle = grad;
	g.fillRect(0, 0, c.width, c.height);

	// Guilloche-style fine lines, the texture that makes it read as money.
	g.strokeStyle = 'rgba(255,255,255,0.08)';
	g.lineWidth = 1;
	for (let i = -c.height; i < c.width; i += 9) {
		g.beginPath();
		g.moveTo(i, 0);
		g.lineTo(i + c.height, c.height);
		g.stroke();
	}
	g.strokeStyle = 'rgba(255,255,255,0.75)';
	g.lineWidth = 5;
	g.strokeRect(10, 10, c.width - 20, c.height - 20);
	g.lineWidth = 1.5;
	g.strokeRect(20, 20, c.width - 40, c.height - 40);

	// Emblem: the USDC ring on the left.
	g.beginPath();
	g.arc(110, c.height / 2, 58, 0, Math.PI * 2);
	g.fillStyle = 'rgba(255,255,255,0.14)';
	g.fill();
	g.lineWidth = 6;
	g.strokeStyle = '#ffffff';
	g.stroke();
	g.fillStyle = '#ffffff';
	g.font = '700 58px system-ui, -apple-system, Segoe UI, sans-serif';
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillText('$', 110, c.height / 2 + 3);

	g.textAlign = 'right';
	g.font = '800 84px system-ui, -apple-system, Segoe UI, sans-serif';
	g.fillText('0.001', c.width - 36, 96);
	g.font = '700 22px system-ui, -apple-system, Segoe UI, sans-serif';
	g.fillStyle = 'rgba(255,255,255,0.9)';
	g.fillText('ONE TENTH OF A CENT', c.width - 38, 150);
	g.font = '600 17px system-ui, -apple-system, Segoe UI, sans-serif';
	g.fillStyle = 'rgba(255,255,255,0.7)';
	g.fillText('USDC · SETTLED ON-CHAIN · THREE.WS', c.width - 38, 180);

	const tex = new CanvasTexture(c);
	tex.colorSpace = SRGBColorSpace;
	tex.anisotropy = 4;
	return tex;
}

export class ClubMoney {
	/**
	 * @param {object} opts
	 * @param {import('three').Scene} opts.scene
	 * @param {number} opts.capacity        bills alive at once (device budget)
	 * @param {boolean} [opts.reducedMotion] land bills straight on the pile
	 * @param {() => number} [opts.rng]
	 * @param {import('three').Texture} [opts.texture]  injected in tests (no canvas)
	 */
	constructor({ scene, capacity, reducedMotion = false, rng = Math.random, texture = null }) {
		this.capacity = Math.max(1, Math.floor(capacity));
		this.reducedMotion = reducedMotion;
		this.rng = rng;
		/** @type {Map<string, {x:number,z:number,topY:number,radius:number,stack:number}>} */
		this.stages = new Map();

		const n = this.capacity;
		this.state = new Uint8Array(n);
		this.pos = new Float32Array(n * 3);
		this.vel = new Float32Array(n * 3);
		this.rot = new Float32Array(n * 3);
		this.spin = new Float32Array(n * 3);
		this.phase = new Float32Array(n);
		this.target = new Float32Array(n * 2);
		this.restY = new Float32Array(n);
		this.stageOf = new Array(n).fill(null);
		this.restOrder = []; // slot indices in landing order: the recycle queue
		this.airborne = 0;
		this.dirty = false;
		this.clock = 0;

		const geo = new PlaneGeometry(BILL_W, BILL_H);
		geo.rotateX(-Math.PI / 2); // identity rotation = lying flat on the floor
		const map = texture || drawBillTexture();
		this.material = new MeshStandardMaterial({
			map,
			emissive: 0xffffff,
			emissiveMap: map,
			emissiveIntensity: 0.22, // readable in a dark room without a spotlight on it
			roughness: 0.78,
			metalness: 0,
			side: DoubleSide,
		});
		this.mesh = new InstancedMesh(geo, this.material, n);
		this.mesh.name = 'club-money';
		this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
		this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
		this.mesh.frustumCulled = false; // instances span the whole room
		this.mesh.castShadow = false;
		this.mesh.receiveShadow = false;
		for (let i = 0; i < n; i++) {
			this.mesh.setMatrixAt(i, ZERO_SCALE);
			this.mesh.setColorAt(i, HUMAN_TINT);
		}
		scene.add(this.mesh);
		this.scene = scene;
	}

	/**
	 * Register (or move) a stage disc bills can land on.
	 * @param {string} id
	 * @param {{x:number,z:number,topY:number,radius:number}} disc
	 */
	setStage(id, { x, z, topY, radius }) {
		const prev = this.stages.get(id);
		this.stages.set(id, { x, z, topY, radius, stack: prev?.stack ?? 0 });
	}

	/** Bills currently resting on a stage (the visible pile). */
	pileSize(id) {
		let n = 0;
		for (let i = 0; i < this.capacity; i++) {
			if (this.state[i] === STATE_REST && this.stageOf[i] === id) n++;
		}
		return n;
	}

	/**
	 * Lay `count` bills straight onto a stage's pile (boot, from real tip counts).
	 * @param {string} id
	 * @param {number} count
	 * @param {{agent?:boolean}} [opts]
	 */
	seed(id, count, { agent = false } = {}) {
		const stage = this.stages.get(id);
		if (!stage) return;
		for (let k = 0; k < count; k++) {
			const i = this._claim();
			const pt = pointOnStage(stage, this.rng);
			this._tint(i, agent);
			this._land(i, id, pt.x, pt.z);
		}
	}

	/**
	 * Throw a clump of bills from `from` (the camera) onto a stage: your own tip.
	 * @param {string} id
	 * @param {{x:number,y:number,z:number}} from
	 * @param {number} [count]
	 */
	throwTo(id, from, count = 8) {
		const stage = this.stages.get(id);
		if (!stage) return;
		for (let k = 0; k < count; k++) {
			const i = this._claim();
			const pt = pointOnStage(stage, this.rng);
			this._tint(i, false);
			if (this.reducedMotion) { this._land(i, id, pt.x, pt.z); continue; }
			const jitter = () => (this.rng() - 0.5) * 0.25;
			const start = { x: from.x + jitter(), y: from.y - 0.35 + jitter() * 0.5, z: from.z + jitter() };
			// Aim a touch above the stage so the bill flutters the last stretch down.
			const aim = { x: pt.x, y: stage.topY + 0.9 + this.rng() * 0.5, z: pt.z };
			const v = ballisticVelocity(start, aim, THROW_FLIGHT_SEC * (0.85 + this.rng() * 0.3));
			this._launch(i, id, start, v, pt, STATE_THROWN);
		}
	}

	/**
	 * Drop bills out of the rig above a stage: someone else's tip.
	 * @param {string} id
	 * @param {number} [count]
	 * @param {{agent?:boolean}} [opts]
	 */
	dropOn(id, count = 1, { agent = false } = {}) {
		const stage = this.stages.get(id);
		if (!stage) return;
		for (let k = 0; k < count; k++) {
			const i = this._claim();
			const pt = pointOnStage(stage, this.rng);
			this._tint(i, agent);
			if (this.reducedMotion) { this._land(i, id, pt.x, pt.z); continue; }
			const start = {
				x: pt.x + (this.rng() - 0.5) * 0.6,
				y: stage.topY + DROP_HEIGHT + this.rng() * 0.8,
				z: pt.z + (this.rng() - 0.5) * 0.6,
			};
			this._launch(i, id, start, { x: 0, y: TERMINAL_FALL, z: 0 }, pt, STATE_FLUTTER);
		}
	}

	/** Advance every airborne bill. Resting bills cost nothing per frame. */
	update(dt) {
		this.clock += dt;
		if (this.airborne > 0) {
			for (let i = 0; i < this.capacity; i++) {
				const st = this.state[i];
				if (st === STATE_THROWN) this._stepThrown(i, dt);
				else if (st === STATE_FLUTTER) this._stepFlutter(i, dt);
			}
		}
		if (this.dirty) {
			this.mesh.instanceMatrix.needsUpdate = true;
			if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
			this.dirty = false;
		}
	}

	dispose() {
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.map?.dispose();
		this.material.dispose();
		this.mesh.dispose?.();
	}

	// ── internals ────────────────────────────────────────────────────────

	/** A free slot, or the oldest resting bill when the budget is full. */
	_claim() {
		for (let i = 0; i < this.capacity; i++) {
			if (this.state[i] === STATE_FREE) return i;
		}
		if (this.restOrder.length) {
			const i = this.restOrder.shift();
			this.state[i] = STATE_FREE;
			return i;
		}
		// Every slot is airborne: reuse the first one; it is mid-air anyway.
		this.airborne = Math.max(0, this.airborne - 1);
		return 0;
	}

	_tint(i, agent) {
		this.mesh.setColorAt(i, agent ? AGENT_TINT : HUMAN_TINT);
		this.dirty = true;
	}

	_launch(i, id, start, v, pt, state) {
		const o = i * 3;
		this.pos[o] = start.x; this.pos[o + 1] = start.y; this.pos[o + 2] = start.z;
		this.vel[o] = v.x; this.vel[o + 1] = v.y; this.vel[o + 2] = v.z;
		this.rot[o] = this.rng() * Math.PI * 2;
		this.rot[o + 1] = this.rng() * Math.PI * 2;
		this.rot[o + 2] = this.rng() * Math.PI * 2;
		this.spin[o] = (this.rng() - 0.5) * 9;
		this.spin[o + 1] = (this.rng() - 0.5) * 5;
		this.spin[o + 2] = (this.rng() - 0.5) * 9;
		this.phase[i] = this.rng() * Math.PI * 2;
		this.target[i * 2] = pt.x;
		this.target[i * 2 + 1] = pt.z;
		this.stageOf[i] = id;
		this.state[i] = state;
		this.airborne++;
		this._write(i);
	}

	_stepThrown(i, dt) {
		const o = i * 3;
		this.vel[o + 1] += GRAVITY * dt;
		this.pos[o] += this.vel[o] * dt;
		this.pos[o + 1] += this.vel[o + 1] * dt;
		this.pos[o + 2] += this.vel[o + 2] * dt;
		this.rot[o] += this.spin[o] * dt * 1.6;
		this.rot[o + 1] += this.spin[o + 1] * dt;
		this.rot[o + 2] += this.spin[o + 2] * dt * 1.6;
		// Paper catches the air once it starts to fall: hand over to the flutter.
		if (this.vel[o + 1] < FLUTTER_BELOW_VY) this.state[i] = STATE_FLUTTER;
		this._write(i);
	}

	_stepFlutter(i, dt) {
		const o = i * 3;
		const stage = this.stages.get(this.stageOf[i]);
		const floorY = this._restHeight(stage);
		// Ease toward terminal fall speed, and drift toward the landing point
		// while swaying side to side like paper does.
		this.vel[o + 1] += (TERMINAL_FALL - this.vel[o + 1]) * Math.min(1, dt * 3.5);
		const tx = this.target[i * 2];
		const tz = this.target[i * 2 + 1];
		const t = this.clock * 3.1 + this.phase[i];
		this.vel[o] += ((tx - this.pos[o]) * 1.2 - this.vel[o]) * Math.min(1, dt * 2.5);
		this.vel[o + 2] += ((tz - this.pos[o + 2]) * 1.2 - this.vel[o + 2]) * Math.min(1, dt * 2.5);
		this.pos[o] += (this.vel[o] + Math.sin(t) * 0.55) * dt;
		this.pos[o + 1] += this.vel[o + 1] * dt;
		this.pos[o + 2] += (this.vel[o + 2] + Math.cos(t * 0.8) * 0.4) * dt;
		// Rock around the flat pose rather than tumbling end over end: a
		// fluttering bill mostly faces the floor.
		const h = Math.max(0, this.pos[o + 1] - floorY);
		const settle = Math.min(1, h / 0.6);
		this.rot[o] = Math.sin(t * 1.3) * 0.7 * settle;
		this.rot[o + 1] += this.spin[o + 1] * dt * 0.6;
		this.rot[o + 2] = Math.cos(t) * 0.55 * settle;
		if (this.pos[o + 1] <= floorY) {
			this.airborne = Math.max(0, this.airborne - 1);
			this._land(i, this.stageOf[i], this.pos[o], this.pos[o + 2]);
			return;
		}
		this._write(i);
	}

	_restHeight(stage) {
		return stage ? stage.topY + REST_LIFT + stage.stack : REST_LIFT;
	}

	_land(i, id, x, z) {
		const stage = this.stages.get(id);
		const o = i * 3;
		// On the disc the bill lies on the stage top; a stray that drifted past the
		// rim lies on the club floor at its feet.
		const onDisc = stage && Math.hypot(x - stage.x, z - stage.z) <= stage.radius - 0.02;
		const y = onDisc ? this._restHeight(stage) : REST_LIFT;
		if (onDisc) stage.stack = Math.min(STACK_MAX, stage.stack + STACK_STEP);
		this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
		this.rot[o] = (this.rng() - 0.5) * 0.06;
		this.rot[o + 1] = this.rng() * Math.PI * 2;
		this.rot[o + 2] = (this.rng() - 0.5) * 0.06;
		this.restY[i] = y;
		this.stageOf[i] = id;
		this.state[i] = STATE_REST;
		const at = this.restOrder.indexOf(i);
		if (at >= 0) this.restOrder.splice(at, 1);
		this.restOrder.push(i);
		this._write(i);
	}

	_write(i) {
		const o = i * 3;
		_p.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
		_q.setFromEuler(_e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]));
		_m.compose(_p, _q, _s);
		this.mesh.setMatrixAt(i, _m);
		this.dirty = true;
	}
}
