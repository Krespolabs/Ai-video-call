// The /club stage: money on the piles, the floor crowd's layout, and picking a
// dancer by clicking her in the scene. Pure pieces only, no renderer.

import { describe, it, expect } from 'vitest';
import { Scene, Texture, Ray, Vector3 } from 'three';

import { ClubMoney, ballisticVelocity, pointOnStage } from '../src/club-money.js';
import { planFloorCrowd } from '../src/club-floor-crowd.js';
import { rayToColumn } from '../src/club-tip-hud.js';

function seeded(seed = 7) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const STAGE = { x: 2, z: -1, topY: 0.18, radius: 1.1 };

describe('club money', () => {
	it('throw arc lands on the aim point after the flight time', () => {
		const from = { x: 0, y: 1.8, z: 6 };
		const to = { x: 2, y: 1.2, z: -1 };
		const t = 0.9;
		const v = ballisticVelocity(from, to, t);
		const y = from.y + v.y * t + 0.5 * -9.8 * t * t;
		expect(from.x + v.x * t).toBeCloseTo(to.x, 6);
		expect(from.z + v.z * t).toBeCloseTo(to.z, 6);
		expect(y).toBeCloseTo(to.y, 6);
	});

	it('scatters landing points on the disc, clear of the pole', () => {
		const rng = seeded(3);
		for (let i = 0; i < 500; i++) {
			const p = pointOnStage(STAGE, rng);
			const r = Math.hypot(p.x - STAGE.x, p.z - STAGE.z);
			expect(r).toBeGreaterThanOrEqual(0.16 - 1e-9);
			expect(r).toBeLessThanOrEqual(STAGE.radius - 0.12 + 1e-9);
		}
	});

	function makeMoney(capacity, opts = {}) {
		const money = new ClubMoney({ scene: new Scene(), capacity, rng: seeded(11), texture: new Texture(), ...opts });
		money.setStage('1', STAGE);
		money.setStage('2', { ...STAGE, x: -2 });
		return money;
	}

	it('seeds a pile that rests on the stage top', () => {
		const money = makeMoney(50);
		money.seed('1', 12);
		expect(money.pileSize('1')).toBe(12);
		for (let i = 0; i < 12; i++) {
			expect(money.pos[i * 3 + 1]).toBeGreaterThan(STAGE.topY);
			expect(money.pos[i * 3 + 1]).toBeLessThan(STAGE.topY + 0.05);
		}
	});

	it('recycles the oldest resting bill once the budget is full', () => {
		const money = makeMoney(10);
		money.seed('1', 10);
		money.seed('2', 4);
		expect(money.pileSize('1')).toBe(6);
		expect(money.pileSize('2')).toBe(4);
	});

	it('a dropped bill flutters down and joins the pile', () => {
		const money = makeMoney(20);
		money.dropOn('1', 3, { agent: true });
		expect(money.airborne).toBe(3);
		for (let f = 0; f < 60 * 12 && money.airborne; f++) money.update(1 / 60);
		expect(money.airborne).toBe(0);
		expect(money.pileSize('1') + money.pileSize('2')).toBeLessThanOrEqual(3);
		// Stray bills that drift past the rim lie on the floor; most land on the disc.
		expect(money.pileSize('1')).toBeGreaterThanOrEqual(2);
	});

	it('a thrown clump crosses the room and comes to rest', () => {
		const money = makeMoney(20);
		money.throwTo('1', { x: 0, y: 1.8, z: 6 }, 8);
		for (let f = 0; f < 60 * 15 && money.airborne; f++) money.update(1 / 60);
		expect(money.airborne).toBe(0);
		expect(money.pileSize('1')).toBeGreaterThanOrEqual(6);
	});

	it('lands bills straight on the pile under reduced motion', () => {
		const money = makeMoney(20, { reducedMotion: true });
		money.throwTo('1', { x: 0, y: 1.8, z: 6 }, 5);
		expect(money.airborne).toBe(0);
		expect(money.pileSize('1')).toBe(5);
	});
});

describe('floor crowd plan', () => {
	const stages = [
		{ id: '1', x: -3.47, z: -0.97, radius: 1.1 },
		{ id: '2', x: 0, z: -2.8, radius: 1.1 },
		{ id: '3', x: 3.47, z: -0.97, radius: 1.1 },
	];
	const camera = { x: 0, z: 6 };

	it('places people off the stages, spaced, and facing the pole', () => {
		const slots = planFloorCrowd({ stages, camera, count: 12, rng: seeded(5) });
		expect(slots.length).toBeGreaterThan(8);
		expect(slots.length).toBeLessThanOrEqual(12);
		for (const s of slots) {
			for (const st of stages) {
				expect(Math.hypot(s.x - st.x, s.z - st.z)).toBeGreaterThan(st.radius + 0.6);
			}
			const own = stages.find((st) => st.id === s.stageId);
			const facing = Math.atan2(own.x - s.x, own.z - s.z);
			expect(Math.abs(Math.atan2(Math.sin(s.yaw - facing), Math.cos(s.yaw - facing)))).toBeLessThan(0.2);
		}
		for (let i = 0; i < slots.length; i++) {
			for (let j = i + 1; j < slots.length; j++) {
				expect(Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z)).toBeGreaterThanOrEqual(0.78 - 1e-9);
			}
		}
	});

	it('keeps the wedge between each stage and the camera clear', () => {
		const slots = planFloorCrowd({ stages, camera, count: 12, rng: seeded(9) });
		for (const s of slots) {
			const st = stages.find((x) => x.id === s.stageId);
			const toCam = Math.atan2(camera.x - st.x, camera.z - st.z);
			const toSlot = Math.atan2(s.x - st.x, s.z - st.z);
			const diff = Math.abs(Math.atan2(Math.sin(toSlot - toCam), Math.cos(toSlot - toCam)));
			expect(diff).toBeGreaterThanOrEqual(0.95);
		}
	});

	it('keeps a stage\'s declared close-up sightline clear too', () => {
		const vip = stages.map((st) => ({ ...st, clearDirs: [Math.PI / 2] }));
		const slots = planFloorCrowd({ stages: vip, camera, count: 12, rng: seeded(21) });
		expect(slots.length).toBeGreaterThan(0);
		for (const s of slots) {
			const st = vip.find((x) => x.id === s.stageId);
			const toSlot = Math.atan2(s.x - st.x, s.z - st.z);
			const diff = Math.abs(Math.atan2(Math.sin(toSlot - Math.PI / 2), Math.cos(toSlot - Math.PI / 2)));
			expect(diff).toBeGreaterThanOrEqual(0.95);
		}
	});

	it('returns nothing for an empty room or zero budget', () => {
		expect(planFloorCrowd({ stages: [], camera, count: 10 })).toEqual([]);
		expect(planFloorCrowd({ stages, camera, count: 0 })).toEqual([]);
	});
});

describe('picking a dancer in the scene', () => {
	const col = { x: 0, z: -3, y0: 0, y1: 2.4 };

	it('a ray through the dancer hits her column', () => {
		const ray = new Ray(new Vector3(0, 1.8, 6), new Vector3(0, 1.0 - 1.8, -9).normalize());
		const hit = rayToColumn(ray, col);
		expect(hit.dist).toBeLessThan(0.05);
		expect(hit.t).toBeGreaterThan(8);
	});

	it('a ray well to the side misses', () => {
		const ray = new Ray(new Vector3(0, 1.8, 6), new Vector3(2, -0.2, -9).normalize());
		expect(rayToColumn(ray, col).dist).toBeGreaterThan(0.62);
	});

	it('a ray passing over her head measures to the top of the column', () => {
		const ray = new Ray(new Vector3(0, 4, 6), new Vector3(0, 0, -1));
		const hit = rayToColumn(ray, col);
		expect(hit.dist).toBeCloseTo(4 - 2.4, 5);
	});
});
