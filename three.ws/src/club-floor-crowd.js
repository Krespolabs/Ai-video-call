// /club floor crowd: the people standing around the stages.
//
// The walk-in hands you off to a room that used to be empty: three stages and
// nobody watching them. This module plans where a crowd stands inside the club
// (a loose ring around each stage, facing the pole) and drives it: when a
// person's tip puts a dancer on her pole, the people at that stage cheer.
//
// The bodies themselves come from ClubCrowd (src/club-crowd.js), the same
// roster, retarget cache and clip pools that fill the alley line, fed through
// its directed-lineup path so every member lands on an exact planned spot.
// Nobody is placed in the wedge between a stage and the default camera, or in
// any other sightline a stage declares (its close-up camera), so the crowd
// frames the dancer instead of blocking her.

import { ClubCrowd } from './club-crowd.js';
import { log } from './shared/log.js';

// Mood pools for a standing audience. Names must exist in the animation
// manifest; ClubCrowd drops any a rig cannot play and falls back to idle.
const WATCH_CLIPS = ['av-listening-music', 'av-idle-breath', 'idle', 'av-waiting'];
const HYPE_CLIPS = ['av-cheering', 'av-banging-tunes', 'av-headbang', 'av-dance-shuffle', 'dance'];
const CHEER_GESTURE = ['av-cheering'];

const RING_GAP_MIN = 0.75;    // metres past the stage rim
const RING_GAP_MAX = 1.45;
const CAMERA_WEDGE = 0.95;    // half-angle (rad) kept clear toward the camera
const MIN_SPACING = 0.78;
const HYPE_SHARE = 0.4;       // fraction of the audience already moving to the music

/** Signed smallest difference between two angles. */
function angleDiff(a, b) {
	let d = (a - b) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return d;
}

/**
 * Plan crowd spots around the stages. Pure and seedable, so the layout is
 * unit-testable without a renderer.
 *
 * @param {object} opts
 * @param {Array<{id:string,x:number,z:number,radius:number,clearDirs?:number[]}>} opts.stages
 *   `clearDirs` are extra headings (atan2(dx, dz) from the stage centre) whose
 *   wedge is kept empty, e.g. where that stage's close-up camera sits
 * @param {{x:number,z:number}} opts.camera  default viewpoint to keep clear
 * @param {number} opts.count               total audience size
 * @param {() => number} [opts.rng]
 * @returns {Array<{stageId:string,x:number,y:number,z:number,yaw:number,clips:string[]}>}
 */
export function planFloorCrowd({ stages, camera, count, rng = Math.random }) {
	const slots = [];
	if (!stages.length || count <= 0) return slots;
	const clear = (x, z) => {
		for (const s of stages) {
			if (Math.hypot(x - s.x, z - s.z) < s.radius + RING_GAP_MIN - 0.05) return false;
		}
		for (const p of slots) {
			if (Math.hypot(x - p.x, z - p.z) < MIN_SPACING) return false;
		}
		return true;
	};
	const perStage = Math.ceil(count / stages.length);
	for (const stage of stages) {
		const keepClear = [Math.atan2(camera.x - stage.x, camera.z - stage.z), ...(stage.clearDirs || [])];
		let placed = 0;
		for (let tries = 0; tries < perStage * 30 && placed < perStage && slots.length < count; tries++) {
			const a = rng() * Math.PI * 2;
			if (keepClear.some((dir) => Math.abs(angleDiff(a, dir)) < CAMERA_WEDGE)) continue;
			const r = stage.radius + RING_GAP_MIN + rng() * (RING_GAP_MAX - RING_GAP_MIN);
			const x = stage.x + Math.sin(a) * r;
			const z = stage.z + Math.cos(a) * r;
			if (!clear(x, z)) continue;
			// Face the pole, with a little head-turn so the ring isn't robotic.
			const yaw = Math.atan2(stage.x - x, stage.z - z) + (rng() - 0.5) * 0.35;
			const clips = rng() < HYPE_SHARE ? HYPE_CLIPS : WATCH_CLIPS;
			slots.push({ stageId: stage.id, x, y: 0, z, yaw, clips });
			placed++;
		}
	}
	return slots;
}

export class ClubFloorCrowd {
	/**
	 * @param {object} opts
	 * @param {import('three').WebGLRenderer} opts.renderer
	 * @param {import('three').Scene} opts.scene
	 * @param {Array} opts.manifest   animation manifest
	 * @param {Array<{name:string,url:string}>} opts.bundled  offline-safe rigs
	 */
	constructor({ renderer, scene, manifest, bundled }) {
		this.crowd = new ClubCrowd({ renderer, scene, manifest, max: 64, bundled });
		/** @type {Map<string, object[]>} stage id -> members standing at it */
		this.byStage = new Map();
	}

	/**
	 * Fill the floor. Safe to call once; members stream in without stalling a
	 * frame, and any load failure leaves a smaller (or empty) crowd.
	 * @param {object} opts
	 * @param {import('three').Object3D} opts.envRoot
	 * @param {Array<{id:string,x:number,z:number,radius:number}>} opts.stages
	 * @param {{x:number,z:number}} opts.camera
	 * @param {number} opts.count
	 */
	mount({ envRoot, stages, camera, count }) {
		const slots = planFloorCrowd({ stages, camera, count });
		if (!slots.length) return;
		this.byStage.clear();
		const origin = { x: camera.x, y: 0, z: camera.z };
		this.crowd.mount({
			envRoot,
			bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
			path: { spawn: origin, door: origin },
			max: slots.length,
			lineup: {
				slots,
				onMember: (inst, slot) => {
					const list = this.byStage.get(slot.stageId) || [];
					list.push(inst);
					this.byStage.set(slot.stageId, list);
				},
			},
		});
		log.info(`[club-floor-crowd] planned ${slots.length} around ${stages.length} stages`);
	}

	/** The people at one stage cheer (a person's tip just landed there). */
	cheer(stageId) {
		for (const inst of this.byStage.get(stageId) || []) {
			// Stagger so the ring erupts rather than moving as one body.
			setTimeout(() => this.crowd.gesture(inst, CHEER_GESTURE), Math.random() * 450);
		}
	}

	update(dt) {
		this.crowd.update(dt);
	}

	dispose() {
		this.crowd.dispose();
		this.byStage.clear();
	}
}
