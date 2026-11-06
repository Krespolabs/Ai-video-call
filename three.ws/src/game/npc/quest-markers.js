// Quest-zone markers (W08 hooking W05) — the visual half of
// multiplayer/src/quest-zones.js, whose own header names this exact gap:
// "the client (quest-systems — renders the markers...)" was never written,
// so every goto/interact zone the quest engine already validates server-side
// was completely invisible in the world. This module is that renderer: a
// ground ring + floating waypoint chip for every zone tied to the player's
// CURRENT objective on any active mission (not every zone in the registry —
// a jobs board with three accepted missions shows three waypoints, not the
// whole map lit up), driven purely by the 'quests' snapshot the server
// already sends. A goto zone auto-completes from the player's own movement
// (WalkRoom's zone-entry edge detection) — this only has to show WHERE to
// walk. An interact zone additionally offers the shared "press E" prompt
// world-life.js already draws for NPCs; interact() there calls
// net.questInteract() when a quest zone (not an NPC) is nearest, and the
// server re-derives the zone from the player's authoritative position, same
// anti-cheat posture as every other off-schema action.

import { Group, Mesh, RingGeometry, MeshBasicMaterial, DoubleSide } from 'three';
import { QUEST_ZONES, ZONE_REACH } from '../../../multiplayer/src/quest-zones.js';

const ZONE_BY_ID = new Map(QUEST_ZONES.map((z) => [z.id, z]));
const GOTO_COLOR = 0x6ec6ff;
const INTERACT_COLOR = 0xffce6e; // matches the 'quest' NPC role tint

export class QuestMarkers {
	constructor({ scene, net }) {
		this.scene = scene;
		this.net = net;
		this.group = new Group();
		scene.add(this.group);
		this.zones = new Map(); // zoneId -> { ring, label, zone, objLabel }
		this._pulseT = 0;
		this._injectStyles();

		this._unsub = net?.on ? net.on('quests', (snap) => this._applySnapshot(snap)) : null;
		net?.requestQuests?.();
	}

	_injectStyles() {
		if (document.getElementById('quest-marker-styles')) return;
		const s = document.createElement('style');
		s.id = 'quest-marker-styles';
		s.textContent = `
		.quest-marker-label {
			position: fixed; left: 0; top: 0; z-index: 15; pointer-events: none;
			transform: translate(-50%, -100%); white-space: nowrap;
			background: rgba(12, 12, 14, 0.72); border: 1px solid rgba(255, 206, 110, 0.5);
			color: #ffe8c2; font-size: 11px; font-weight: 700; letter-spacing: 0.03em;
			padding: 4px 9px; border-radius: 999px; box-shadow: 0 0 10px rgba(255, 206, 110, 0.2);
			transition: opacity 0.18s ease;
		}
		.quest-marker-label.qm-goto { border-color: rgba(110, 198, 255, 0.5); color: #d6ecff; box-shadow: 0 0 10px rgba(110, 198, 255, 0.2); }`;
		document.head.appendChild(s);
	}

	// Which zone (if any) is the current-stage objective of an active run.
	// Multi-zone objectives (the vault's two terminals) surface every zone in
	// the set — either one advances the shared count.
	_applySnapshot(snap) {
		const wantLabels = new Map(); // zoneId -> objective label
		for (const run of snap?.active || []) {
			const obj = (run.objectives || [])[run.stage];
			if (!obj) continue;
			const label = obj.label || run.title;
			if (obj.zone) wantLabels.set(obj.zone, label);
			if (Array.isArray(obj.zones)) for (const z of obj.zones) wantLabels.set(z, label);
		}
		this._wantLabels = wantLabels;
		this._sync();
	}

	_sync() {
		const want = this._wantLabels || new Map();
		for (const [id, rec] of this.zones) {
			if (!want.has(id)) { this._disposeOne(rec); this.zones.delete(id); }
		}
		for (const [id, label] of want) {
			const zone = ZONE_BY_ID.get(id);
			if (!zone) continue;
			let rec = this.zones.get(id);
			if (!rec) { rec = this._build(zone); this.zones.set(id, rec); }
			if (rec.objLabel !== label) {
				rec.objLabel = label;
				rec.label.textContent = `${zone.glyph || (zone.kind === 'interact' ? '📍' : '🧭')} ${label}`;
			}
		}
	}

	_build(zone) {
		const color = zone.kind === 'interact' ? INTERACT_COLOR : GOTO_COLOR;
		const ring = new Mesh(
			new RingGeometry(1.3, 1.7, 40),
			new MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: DoubleSide }),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.position.set(zone.x, 0.03, zone.z);
		this.group.add(ring);

		const label = document.createElement('div');
		label.className = `quest-marker-label${zone.kind === 'goto' ? ' qm-goto' : ''}`;
		document.body.appendChild(label);

		return { ring, label, zone, objLabel: null };
	}

	_disposeOne(rec) {
		this.group.remove(rec.ring);
		rec.ring.geometry.dispose();
		rec.ring.material.dispose();
		rec.label.remove();
	}

	// Nearest active INTERACT zone within reach — the counterpart to
	// world-life's `_nearestNpc`, so the shared "press E" prompt can pick
	// whichever is closer.
	nearestInteractZone(player) {
		if (!player) return null;
		let best = null, bestD = Infinity;
		for (const rec of this.zones.values()) {
			if (rec.zone.kind !== 'interact') continue;
			const d = Math.hypot(player.x - rec.zone.x, player.z - rec.zone.z);
			const reach = rec.zone.r + ZONE_REACH;
			if (d <= reach && d < bestD) { best = { zone: rec.zone, label: rec.objLabel }; bestD = d; }
		}
		return best;
	}

	// Ring meshes for the raycast tap-to-activate path (world-life's
	// tryActivateAt), mirroring how NPC marker rings are hit-tested.
	rayTargets() {
		return [...this.zones.values()].map((rec) => rec.ring);
	}

	update(dt, { project } = {}) {
		this._pulseT += dt;
		const pulse = 0.3 + 0.2 * (0.5 + 0.5 * Math.sin(this._pulseT * 2.4));
		for (const rec of this.zones.values()) {
			rec.ring.material.opacity = pulse;
			if (project) project(rec.label, rec.zone.x, 1.7, rec.zone.z);
		}
	}

	dispose() {
		this._unsub?.();
		for (const rec of this.zones.values()) this._disposeOne(rec);
		this.zones.clear();
		this.scene.remove(this.group);
	}
}
