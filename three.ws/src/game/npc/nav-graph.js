// Deterministic navigation substrate for the living world (W08).
//
// The world has no streamed road network yet (that lands with W01). Until then,
// this module synthesizes a navigation graph from the plaza's own geometry — a
// set of closed pedestrian loops and one ring road — entirely as a *pure
// function of the world seed*. Same coin → identical graph on every client, so
// the crowd and traffic that ride it (ambient-life.js) read the same everywhere
// without syncing a single NPC over the wire.
//
// When W01 ships a real navmesh it registers it via `registerNavmesh()`; from
// then on `findPath()` routes through three-pathfinding (lazy-imported only when
// a navmesh actually exists, so the package never weighs on the bundle until the
// foundation that needs it is merged). Everything else — pedestrians, traffic,
// mob AI — consumes this one graph, so the day the navmesh arrives the world's
// life upgrades in place.

import { Vector3 } from 'three';

// mulberry32 — a tiny, fast, seedable PRNG. Deterministic given a seed, so the
// whole graph (and the life on it) is reproducible across clients.
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// One closed ring of points at radius R, with optional per-point radial waviness
// so a pedestrian loop reads as an organic stroll rather than a perfect circle.
function ringLoop(R, segments, rand, waviness = 0) {
	const pts = [];
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		const r = R * (1 + (waviness ? (rand() - 0.5) * 2 * waviness : 0));
		pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
	}
	return pts;
}

// Arc-length of a closed polyline (last point wraps to the first).
function loopLength(pts) {
	let len = 0;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i], b = pts[(i + 1) % pts.length];
		len += Math.hypot(b.x - a.x, b.z - a.z);
	}
	return len;
}

// Sample a closed polyline at arc-length `dist` (wrapping). Returns the world
// position and the unit tangent (heading) at that point — the heading lets an
// NPC face the way it's walking with zero extra state.
function sampleLoop(pts, dist) {
	const total = loopLength(pts);
	let d = ((dist % total) + total) % total;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i], b = pts[(i + 1) % pts.length];
		const seg = Math.hypot(b.x - a.x, b.z - a.z);
		if (d <= seg || i === pts.length - 1) {
			const t = seg > 1e-6 ? d / seg : 0;
			return {
				x: a.x + (b.x - a.x) * t,
				z: a.z + (b.z - a.z) * t,
				dirX: seg > 1e-6 ? (b.x - a.x) / seg : 0,
				dirZ: seg > 1e-6 ? (b.z - a.z) / seg : 1,
			};
		}
		d -= seg;
	}
	return { x: pts[0].x, z: pts[0].z, dirX: 0, dirZ: 1 };
}

export class NavGraph {
	// radius: the inner play circle NPCs may roam (kept inside the server clamp).
	constructor({ radius = 54, seed = 0 } = {}) {
		this.radius = radius;
		this.seed = seed >>> 0;
		const rand = mulberry32(this.seed || 0x3d3d3d);

		// Pedestrian loops at descending radii so foot traffic fills the plaza in
		// depth instead of a single conga line. Jittered for organic paths.
		this.pedLoops = [
			ringLoop(radius * 0.82, 18, rand, 0.05),
			ringLoop(radius * 0.58, 14, rand, 0.06),
			ringLoop(radius * 0.34, 10, rand, 0.07),
		];
		// Each loop's cached length, so samplers don't recompute every frame.
		this._pedLens = this.pedLoops.map(loopLength);

		// One clean ring road just inside the plaza edge — vehicles want a smooth,
		// predictable path, so no waviness here. Width drives the asphalt band the
		// world-life manager paints under it.
		this.road = ringLoop(radius * 0.92, 48, rand);
		this.roadRadius = radius * 0.92;
		this.roadLen = loopLength(this.road);
		this.roadWidth = 4.6;

		// W01 navmesh, registered later. While null, every query falls back to the
		// synthesized graph above.
		this._navmesh = null;       // { zone, geometry } once W01 registers one
		this._pathfinding = null;   // lazily-constructed three-pathfinding instance
		this._zoneId = 'play';
	}

	// Sample pedestrian loop `i` at arc-length `dist`. Pure function of its args,
	// hence identical on every client given the same world time.
	pedPoint(i, dist) {
		const loop = this.pedLoops[i % this.pedLoops.length];
		return sampleLoop(loop, dist);
	}
	pedLoopLength(i) { return this._pedLens[i % this._pedLens.length]; }
	get pedLoopCount() { return this.pedLoops.length; }

	// Sample the ring road at arc-length `dist`, offset `lane` metres to the
	// inside (negative) or outside (positive) of the centre-line.
	roadPoint(dist, lane = 0) {
		const p = sampleLoop(this.road, dist);
		// Right-hand normal of the tangent, scaled by the lane offset.
		return { x: p.x + p.dirZ * lane, z: p.z - p.dirX * lane, dirX: p.dirX, dirZ: p.dirZ };
	}

	// W01 hands us its navmesh geometry + zone here. We don't build the
	// three-pathfinding instance yet — that happens lazily on the first findPath()
	// so the package stays out of the bundle until a navmesh is genuinely present.
	registerNavmesh({ geometry, zoneId = 'play' } = {}) {
		if (!geometry) return;
		this._navmesh = { geometry };
		this._zoneId = zoneId;
		this._pathfinding = null; // rebuild on next path query
	}
	get hasNavmesh() { return !!this._navmesh; }

	// Route from `from` to `to`. With a navmesh, this is a real A* path through
	// three-pathfinding; without one, a straight segment (the synthesized graph is
	// open plaza, so a direct line is the honest answer). Async because the
	// pathfinder is lazy-imported on first use.
	async findPath(from, to) {
		const start = from instanceof Vector3 ? from : new Vector3(from.x, from.y || 0, from.z);
		const end = to instanceof Vector3 ? to : new Vector3(to.x, to.y || 0, to.z);
		if (!this._navmesh) return [end.clone()];
		try {
			if (!this._pathfinding) {
				const { Pathfinding } = await import('three-pathfinding');
				this._pathfinding = new Pathfinding();
				this._pathfinding.setZoneData(this._zoneId, Pathfinding.createZone(this._navmesh.geometry));
			}
			const groupId = this._pathfinding.getGroup(this._zoneId, start);
			const path = this._pathfinding.findPath(start, end, this._zoneId, groupId);
			return path && path.length ? path : [end.clone()];
		} catch {
			// A malformed navmesh shouldn't strand an NPC — fall back to direct.
			return [end.clone()];
		}
	}
}
