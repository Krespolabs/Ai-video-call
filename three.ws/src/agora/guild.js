// Agora — the Guild live view (Task 09). A Collaborative task rendered as a shared
// structure that RISES as each contributor's part lands: one block per slot, the
// filled blocks solid guild-green (a real, landed contribution with its own proof +
// escrow-measured share), the remaining slots ghosted. On completion the split reward
// flows to each contributor with their share label (shown in the shared roster HUD);
// a Guild that misses its worker target before the deadline expires — its ghost slots
// go cold and the unspent pool returns to the creator.
//
// Self-mounting like the trust surface: listens for `agora:open-guild` (dispatched by
// the job board) and an `?guild=<pda>` deep link. Never touches the scaffold.

import * as THREE from 'three';
import { guildFill } from './task-progress.js';
import { LiveView } from './live-view.js';

const GUILD_GREEN = 0x38d39f;
const COLD = 0x6b7280;
const RETURNED = 0xff6b57;
const BLOCK_H = 0.52;
const BLOCK_W = 2.6;
const BLOCK_D = 2.0;

// The rising-structure scene adapter. A fixed set of slot meshes (one per max worker)
// is built once; sync marks how many are filled and whether the guild expired; frame
// eases the filled blocks up into place.
function guildScene() {
	let ctx = null;
	let slots = []; // { mesh, mat, filled, targetScale, cur }
	let baseGroup = null;
	const shared = {};
	let built = 0;
	let maxSlots = 0;
	let expired = false;

	function build(c) {
		ctx = c;
		const { THREE: T, group } = c;
		baseGroup = new T.Group();
		group.add(baseGroup);
		group.position.y = -1.3;

		const padGeo = new T.CylinderGeometry(2.6, 2.9, 0.3, 36);
		const padMat = new T.MeshStandardMaterial({ color: 0x141922, roughness: 0.85, metalness: 0.15 });
		const pad = new T.Mesh(padGeo, padMat);
		pad.position.y = 0.15;
		baseGroup.add(pad);

		shared.blockGeo = new T.BoxGeometry(BLOCK_W, BLOCK_H, BLOCK_D);
		shared.edgeGeo = new T.EdgesGeometry(shared.blockGeo);
		shared.disposables = [padGeo, padMat];
	}

	function ensureSlots(n) {
		const { THREE: T } = ctx;
		if (n === maxSlots) return;
		// Tear down and rebuild the stack when the slot count changes (rare — once).
		for (const s of slots) { baseGroup.remove(s.group); s.mat.dispose(); s.edgeMat?.dispose(); }
		slots = [];
		maxSlots = n;
		for (let i = 0; i < n; i++) {
			const grp = new T.Group();
			const mat = new T.MeshStandardMaterial({ color: COLD, roughness: 0.5, metalness: 0.2, transparent: true, opacity: 0.18 });
			const mesh = new T.Mesh(shared.blockGeo, mat);
			grp.add(mesh);
			const edgeMat = new T.LineBasicMaterial({ color: COLD, transparent: true, opacity: 0.4 });
			const edges = new T.LineSegments(shared.edgeGeo, edgeMat);
			grp.add(edges);
			grp.position.y = 0.3 + BLOCK_H / 2 + i * BLOCK_H;
			grp.scale.y = 1;
			baseGroup.add(grp);
			slots.push({ group: grp, mesh, mat, edges, edgeMat, filled: false, cur: 0, target: 0 });
		}
		// Frame the whole stack.
		if (ctx.camera) {
			const h = 0.3 + n * BLOCK_H;
			ctx.camera.position.set(0, h * 0.6 + 1.6, 8.4);
			ctx.camera.lookAt(0, h * 0.5, 0);
		}
	}

	function sync(view) {
		if (!ctx) return;
		maxSlots = 0; // force ensureSlots to (re)build if needed
		const max = Math.max(1, Number(view.workersMax) || 1);
		ensureSlots(max);
		built = view.settlement?.contributorCount != null
			? Number(view.settlement.contributorCount)
			: (view.roster || []).filter((r) => r.state === 'contributed' || r.state === 'completed').length;
		built = Math.max(0, Math.min(max, built));
		expired = !!view.settlement?.expiredUnderTarget;

		slots.forEach((s, i) => {
			const isFilled = i < built;
			s.filled = isFilled;
			s.target = isFilled ? 1 : 0.18; // built blocks animate up to full presence
			if (isFilled) {
				s.mat.color.setHex(GUILD_GREEN);
				s.mat.emissive?.setHex?.(0x0b3a2c);
				s.mat.opacity = 1;
				s.edgeMat.color.setHex(GUILD_GREEN);
				s.edgeMat.opacity = 0.6;
			} else {
				s.mat.color.setHex(expired ? RETURNED : COLD);
				s.mat.opacity = expired ? 0.12 : 0.18;
				s.edgeMat.color.setHex(expired ? RETURNED : COLD);
				s.edgeMat.opacity = expired ? 0.5 : 0.4;
			}
		});
	}

	function frame(dt, reduced) {
		for (const s of slots) {
			if (!s.filled) { s.group.scale.y = 1; continue; }
			// Rise-in: a freshly filled block grows from the deck into place.
			if (reduced) { s.cur = 1; }
			else { s.cur += (1 - s.cur) * Math.min(1, dt * 3); }
			const scale = 0.05 + 0.95 * s.cur;
			s.group.scale.y = scale;
		}
	}

	function dispose() {
		for (const s of slots) { s.mat.dispose(); s.edgeMat?.dispose(); }
		slots = [];
		shared.blockGeo?.dispose();
		shared.edgeGeo?.dispose();
		for (const d of shared.disposables || []) d.dispose?.();
	}

	return { build, sync, frame, dispose };
}

// ── Self-mount ────────────────────────────────────────────────────────────────
let _view = null;
function view() {
	if (!_view) _view = new LiveView({ kind: 'guild', sceneAdapter: guildScene() });
	return _view;
}

function openGuild(detail) {
	const t = detail?.task || detail || {};
	const taskPda = t.taskPda || t.pda || (typeof detail === 'string' ? detail : null);
	if (!taskPda) return;
	const cluster = t.cluster || t.agenc?.cluster || detail?.cluster || 'devnet';
	const opener = detail?.opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
	view().open(taskPda, cluster, opener);
}

function handleDeepLink() {
	const params = new URLSearchParams(window.location.search);
	const pda = params.get('guild');
	if (pda) openGuild({ task: { taskPda: pda, cluster: params.get('cluster') || 'devnet' } });
}

export function mountGuild() {
	window.addEventListener('agora:open-guild', (e) => openGuild(e.detail));
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handleDeepLink, { once: true });
	else handleDeepLink();
	window.addEventListener('pagehide', () => _view?.dispose(), { once: true });
}

// guildFill is re-exported so external callers / tests can compute the same fill.
export { guildFill };

mountGuild();
