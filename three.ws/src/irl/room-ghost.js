// Live "ghost" preview for /irl room authoring (Epic R / R1).
//
// While the user aims to drop an agent, this renders a translucent stand-in at
// the EXACT world spot the agent will land, so they see it in the room before
// committing — the difference between guessing and placing. It is deliberately a
// lightweight proxy (a glowing figure + a floor footprint), not a clone of the
// skinned avatar GLB: the ghost moves every frame as the phone turns and the
// distance slider scrubs, so it must cost ~nothing, and the real avatar spawns
// the instant Place is tapped (irl.js → spawnNearbyPin).
//
// It is self-contained on the same principle as room-mode.js: irl.js owns the
// scene, the GPS origin and the live compass, and feeds this module the minimal
// pose each frame. The geometry comes from the one shared, unit-tested source —
// room-anchor.js — so the ghost and the persisted placement can never disagree:
// the viewer sits at the world origin (their own GPS), the drop is `distM` along
// the live compass bearing, and the figure faces back toward the viewer (or away
// on the toggle). compassToYaw matches src/irl.js's pinYawRad exactly, so a
// just-placed agent does not visibly rotate when the ghost hands off to it.

import {
	Group,
	Mesh,
	CylinderGeometry,
	SphereGeometry,
	TorusGeometry,
	MeshStandardMaterial,
} from 'three';
import { bearingDistanceToLocal, agentWorldPosition, compassToYaw } from './room-anchor.js';

const ACCENT = 0x7c5cff; // matches the HUD's --accent purple (room-mode.js)

/**
 * Build the ghost and return its controls. The figure is added to `scene` once
 * and toggled with visibility — no per-frame allocation. Nothing renders until
 * setActive(true) AND a GPS fix is present (update() hides it otherwise, so the
 * preview can never imply a placement at null-island).
 *
 * @param {import('three').Scene} scene
 * @param {object} [opts]
 * @param {() => boolean} [opts.reducedMotion]  suppress the pulse for these users
 * @returns {{ setActive(on:boolean):void, setParams(p:{distM?:number,faceViewer?:boolean}):void, update(s:{ready:boolean,headingDeg:number,dt:number}):void, dispose():void }}
 */
export function createRoomGhost(scene, opts = {}) {
	const reducedMotion = opts.reducedMotion || (() => false);

	const group = new Group();
	group.visible = false;
	group.renderOrder = 3;

	// Each part gets its own material so the pulse can drive opacity without
	// touching the shared pin materials. depthWrite off + transparent so the ghost
	// reads as a hologram over the camera feed, never occluding real agents oddly.
	const figureMat = () => new MeshStandardMaterial({
		color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.55,
		transparent: true, opacity: 0.42, roughness: 0.5, metalness: 0, depthWrite: false,
	});
	const bodyMat = figureMat();
	const headMat = figureMat();
	const noseMat = figureMat();
	const ringMat = new MeshStandardMaterial({
		color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.95,
		transparent: true, opacity: 0.6, roughness: 0.4, metalness: 0, depthWrite: false,
	});

	const body = new Mesh(new CylinderGeometry(0.2, 0.26, 1.0, 16), bodyMat);
	body.position.y = 0.62;
	const head = new Mesh(new SphereGeometry(0.2, 16, 12), headMat);
	head.position.y = 1.32;
	// A small forward "nose" cone (cylinder with a zero top radius) so the
	// face-you / face-away toggle is legible at a glance: it points along the
	// figure's local −Z, the same forward our placed avatars use.
	const nose = new Mesh(new CylinderGeometry(0, 0.1, 0.22, 12), noseMat);
	nose.rotation.x = -Math.PI / 2;
	nose.position.set(0, 1.0, -0.26);
	// Floor footprint so the drop spot reads on the ground like a map pin.
	const ring = new Mesh(new TorusGeometry(0.5, 0.03, 8, 48), ringMat);
	ring.rotation.x = Math.PI / 2;
	ring.position.y = 0.02;

	group.add(body, head, nose, ring);
	scene.add(group);

	let pulse = 0;

	/**
	 * Drive the ghost one frame. The room-mode UI calls this from its own
	 * requestAnimationFrame loop while aiming, so all per-frame work stays out of
	 * irl.js's render loop — irl.js only renders the group it already owns.
	 * @param {object} s
	 * @param {boolean} s.on          preview is active (false hides the ghost)
	 * @param {boolean} s.ready       a GPS fix exists (never preview at null-island)
	 * @param {number}  s.headingDeg  live compass bearing the phone points (0–359)
	 * @param {number}  s.distM       drop distance from the slider
	 * @param {boolean} s.faceViewer  agent faces the placer vs. away
	 * @param {number}  s.dt          seconds since the last frame (pulse timing)
	 */
	function preview(s) {
		if (!s || !s.on || !s.ready) { group.visible = false; return; }
		const distM = Number.isFinite(s.distM) ? s.distM : 2.5;
		const headingDeg = Number.isFinite(s.headingDeg) ? s.headingDeg : 0;
		// The viewer is the world origin (their own GPS); the drop is `distM` along
		// the live compass bearing — the same path placeAround/pinWorldPos take, so
		// the ghost sits where the agent will actually render.
		const ahead = bearingDistanceToLocal(headingDeg, distM);
		const w = agentWorldPosition({ originWorld: { x: 0, z: 0 }, relEast: ahead.east, relNorth: ahead.north });
		group.position.set(w.x, w.y, w.z);
		// Faces back toward the placer by default (a person you walked up to), or
		// away on the toggle — bearing + 180 vs the aim bearing.
		const faceBearing = s.faceViewer === false ? headingDeg : headingDeg + 180;
		group.rotation.y = compassToYaw(faceBearing);

		if (reducedMotion()) {
			bodyMat.opacity = headMat.opacity = noseMat.opacity = 0.42;
			ringMat.opacity = 0.6;
			group.scale.setScalar(1);
		} else {
			pulse += Number.isFinite(s.dt) ? s.dt : 0;
			const wob = Math.sin(pulse * 2.2) * 0.5 + 0.5; // 0..1
			bodyMat.opacity = headMat.opacity = noseMat.opacity = 0.34 + wob * 0.16;
			ringMat.opacity = 0.45 + wob * 0.3;
			group.scale.setScalar(1 + wob * 0.015);
		}
		group.visible = true;
	}

	function dispose() {
		scene.remove(group);
		for (const m of group.children) {
			if (m.geometry) m.geometry.dispose();
			if (m.material) m.material.dispose();
		}
	}

	return { preview, dispose };
}
