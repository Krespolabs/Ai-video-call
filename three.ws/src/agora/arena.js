// Agora — the Arena live view (Task 09). A Competitive task rendered as a real 3D
// race: one runner per citizen that claimed the task, its position along the track
// mapped to its ACTUAL work state (entered → racing → proof in → won/stood-down).
// The winner is whoever's proof the chain accepted first; it plays a victory pop as
// the full escrow flows to it, and the others visibly stand down. A leaderboard HUD
// (shared LiveView) is bound to the same live task state.
//
// Self-mounting like the trust surface: it listens for `agora:open-arena` (dispatched
// by the job board when an Arena marker is clicked) and an `?arena=<pda>` deep link,
// and never reaches into the scaffold or the economy layer.

import * as THREE from 'three';
import { LiveView } from './live-view.js';
import { rankRoster, stateProgress } from './task-progress.js';
import { professionThreeColor } from './professions.js';

const TRACK_X0 = -4.6; // start line
const TRACK_X1 = 4.6; // finish line
const LANE_SPAN = 4.2; // total Z spread of the lanes
const GOLD = 0xf0b429;

// The race-track scene adapter. Persistent track geometry is built once; runners are
// diffed against the live roster each sync (added / moved / retired, disposed strictly).
function arenaScene() {
	let ctx = null;
	const runners = new Map(); // citizenId → { group, body, mat, ring, targetX, targetZ, won, lost, phase }
	const shared = {};

	function build(c) {
		ctx = c;
		const { THREE: T, group } = c;

		// Track deck.
		const deckGeo = new T.BoxGeometry(10.4, 0.3, LANE_SPAN + 1.4);
		const deckMat = new T.MeshStandardMaterial({ color: 0x12161f, roughness: 0.9, metalness: 0.1 });
		const deck = new T.Mesh(deckGeo, deckMat);
		deck.position.y = -0.2;
		group.add(deck);

		// Start + finish posts.
		const postGeo = new T.CylinderGeometry(0.06, 0.06, 1.2, 8);
		const startMat = new T.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.5, metalness: 0.5 });
		const finishMat = new T.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.5, roughness: 0.4 });
		for (const z of [-(LANE_SPAN / 2 + 0.5), LANE_SPAN / 2 + 0.5]) {
			const s = new T.Mesh(postGeo, startMat); s.position.set(TRACK_X0, 0.5, z); group.add(s);
			const f = new T.Mesh(postGeo, finishMat); f.position.set(TRACK_X1, 0.5, z); group.add(f);
		}
		// Finish tape.
		const tapeGeo = new T.BoxGeometry(0.06, 0.04, LANE_SPAN + 1);
		const tape = new T.Mesh(tapeGeo, finishMat);
		tape.position.set(TRACK_X1, 0.75, 0);
		group.add(tape);

		shared.bodyGeo = new T.CapsuleGeometry(0.24, 0.42, 4, 10);
		shared.ringGeo = new T.TorusGeometry(0.5, 0.05, 8, 26);
		shared.disposables = [deckGeo, deckMat, postGeo, startMat, finishMat, tapeGeo];
		group.position.y = 0.2;
	}

	function laneZ(i, total) {
		if (total <= 1) return 0;
		return -LANE_SPAN / 2 + (i / (total - 1)) * LANE_SPAN;
	}

	function sync(view) {
		if (!ctx) return;
		const { THREE: T, group } = ctx;
		const roster = rankRoster(view.roster || []);
		const seen = new Set();

		roster.forEach((w, i) => {
			seen.add(w.citizenId);
			const targetX = TRACK_X0 + stateProgress(w.state) * (TRACK_X1 - TRACK_X0);
			const targetZ = laneZ(i, roster.length);
			let r = runners.get(w.citizenId);
			if (!r) {
				const grp = new T.Group();
				const color = professionThreeColor(w.profession).clone();
				const mat = new T.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.2, emissive: color.clone().multiplyScalar(0.25) });
				const body = new T.Mesh(shared.bodyGeo, mat);
				body.position.y = 0.4;
				grp.add(body);
				const ringMat = new T.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false });
				const ring = new T.Mesh(shared.ringGeo, ringMat);
				ring.rotation.x = Math.PI / 2;
				ring.position.y = 0.05;
				grp.add(ring);
				grp.position.set(TRACK_X0, 0, targetZ);
				group.add(grp);
				r = { group: grp, body, mat, ring, ringMat, targetX, targetZ, won: false, lost: false, phase: Math.random() * Math.PI * 2 };
				runners.set(w.citizenId, r);
			}
			r.targetX = targetX;
			r.targetZ = targetZ;
			r.won = w.state === 'won';
			r.lost = w.state === 'lost';
			// A stood-down racer greys out; the winner glows gold.
			const base = professionThreeColor(w.profession);
			if (r.lost) { r.mat.color.setRGB(0.32, 0.34, 0.4); r.mat.emissive.setRGB(0, 0, 0); }
			else { r.mat.color.copy(base); r.mat.emissive.copy(base).multiplyScalar(r.won ? 0.6 : 0.22); }
		});

		// Retire runners no longer present (dispose their materials).
		for (const [id, r] of runners) {
			if (seen.has(id)) continue;
			group.remove(r.group);
			r.mat.dispose(); r.ringMat.dispose();
			runners.delete(id);
		}
	}

	function frame(dt, reduced) {
		const t = performance.now() / 1000;
		for (const r of runners.values()) {
			const g = r.group;
			if (reduced) { g.position.x = r.targetX; g.position.z = r.targetZ; }
			else {
				g.position.x += (r.targetX - g.position.x) * Math.min(1, dt * 3.2);
				g.position.z += (r.targetZ - g.position.z) * Math.min(1, dt * 3.2);
			}
			// Winner: gold ring pulse + a little victory bob.
			const targetOpacity = r.won ? 0.85 : 0;
			r.ringMat.opacity += (targetOpacity - r.ringMat.opacity) * Math.min(1, dt * 4);
			if (r.won && !reduced) {
				r.body.position.y = 0.4 + Math.abs(Math.sin(t * 3 + r.phase)) * 0.18;
				r.ring.rotation.z += dt * 1.5;
			} else {
				r.body.position.y += (0.4 - r.body.position.y) * Math.min(1, dt * 4);
			}
		}
	}

	function dispose() {
		for (const r of runners.values()) { r.mat.dispose(); r.ringMat.dispose(); }
		runners.clear();
		shared.bodyGeo?.dispose(); shared.ringGeo?.dispose();
		for (const d of shared.disposables || []) d.dispose?.();
	}

	return { build, sync, frame, dispose };
}

// ── Self-mount ────────────────────────────────────────────────────────────────
let _view = null;
function view() {
	if (!_view) _view = new LiveView({ kind: 'arena', sceneAdapter: arenaScene() });
	return _view;
}

function openArena(detail) {
	const t = detail?.task || detail || {};
	const taskPda = t.taskPda || t.pda || (typeof detail === 'string' ? detail : null);
	if (!taskPda) return;
	const cluster = t.cluster || t.agenc?.cluster || detail?.cluster || 'devnet';
	const opener = detail?.opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
	view().open(taskPda, cluster, opener);
}

function handleDeepLink() {
	const params = new URLSearchParams(window.location.search);
	const pda = params.get('arena');
	if (pda) openArena({ task: { taskPda: pda, cluster: params.get('cluster') || 'devnet' } });
}

export function mountArena() {
	window.addEventListener('agora:open-arena', (e) => openArena(e.detail));
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handleDeepLink, { once: true });
	else handleDeepLink();
	window.addEventListener('pagehide', () => _view?.dispose(), { once: true });
}

mountArena();
