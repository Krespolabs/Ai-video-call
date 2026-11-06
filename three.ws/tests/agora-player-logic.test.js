/**
 * Agora player mode — unit tests for the pure embodiment rules
 * (src/agora/player-logic.js). No Three.js, DOM, or network — these cover the
 * math that makes /agora playable: camera-relative movement, the motion wire
 * state, building collision, the interaction prompt, and avatar selection.
 */

import { describe, it, expect } from 'vitest';
import {
	WALK_SPEED,
	RUN_SPEED,
	INTERACT_RADIUS,
	PLAYER_RADIUS,
	motionFor,
	stepMovement,
	easeYaw,
	resolveBuildingCollision,
	nearestInteractable,
	chooseAvatarSource,
	guestName,
	isOpenGround,
	findOpenSpawn,
} from '../src/agora/player-logic.js';

describe('motion state (the wire vocabulary)', () => {
	it('maps speed + sprint to idle/walk/run', () => {
		expect(motionFor(0, false)).toBe('idle');
		expect(motionFor(0.39, true)).toBe('idle');
		expect(motionFor(2, false)).toBe('walk');
		expect(motionFor(6, true)).toBe('run');
	});
});

describe('camera-relative movement', () => {
	it('walks forward along -Z when the camera looks down -Z', () => {
		const r = stepMovement({
			input: { forward: 1, strafe: 0 },
			cameraYaw: 0,
			running: false,
			vx: 0, vz: 0, yaw: 0, dt: 1 / 60,
		});
		expect(r.moving).toBe(true);
		expect(r.vx).toBeCloseTo(0, 5);
		expect(r.vz).toBeCloseTo(-WALK_SPEED, 5);
	});

	it('camera yaw rotates the movement basis (forward follows the camera)', () => {
		const r = stepMovement({
			input: { forward: 1, strafe: 0 },
			cameraYaw: Math.PI / 2, // camera looking down -X
			running: false,
			vx: 0, vz: 0, yaw: 0, dt: 1 / 60,
		});
		expect(r.vx).toBeCloseTo(-WALK_SPEED, 5);
		expect(r.vz).toBeCloseTo(0, 5);
	});

	it('sprint uses run speed; analogue magnitude scales it down', () => {
		const sprint = stepMovement({
			input: { forward: 1, strafe: 0 }, cameraYaw: 0, running: true,
			vx: 0, vz: 0, yaw: 0, dt: 1 / 60,
		});
		expect(Math.hypot(sprint.vx, sprint.vz)).toBeCloseTo(RUN_SPEED, 5);

		const gentle = stepMovement({
			input: { forward: 0.5, strafe: 0 }, cameraYaw: 0, running: false,
			vx: 0, vz: 0, yaw: 0, dt: 1 / 60,
		});
		expect(Math.hypot(gentle.vx, gentle.vz)).toBeCloseTo(WALK_SPEED * 0.5, 5);
	});

	it('no input damps velocity toward zero without snapping facing', () => {
		const r = stepMovement({
			input: { forward: 0, strafe: 0 }, cameraYaw: 0, running: false,
			vx: 4, vz: -4, yaw: 1.25, dt: 1 / 60,
		});
		expect(r.moving).toBe(false);
		expect(Math.abs(r.vx)).toBeLessThan(4);
		expect(Math.abs(r.vz)).toBeLessThan(4);
		expect(r.yaw).toBe(1.25); // facing holds while coasting
	});

	it('facing turns the short way round', () => {
		// From just above -π toward just below +π: the short arc crosses ±π.
		const next = easeYaw(-Math.PI + 0.1, Math.PI - 0.1, 1 / 60);
		expect(next).toBeLessThan(-Math.PI + 0.1); // moved toward -π, not the long way
	});
});

describe('building collision (capsule vs AABB)', () => {
	const box = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, h: 10 };

	it('pushes the player out of a wall', () => {
		const r = resolveBuildingCollision(0.9, 0, 0, [box]);
		expect(Math.abs(r.x)).toBeGreaterThanOrEqual(1); // ejected past the face
	});

	it('leaves a clear position untouched', () => {
		const r = resolveBuildingCollision(5, 0, 5, [box]);
		expect(r).toEqual({ x: 5, z: 5 });
	});

	it('a jump above the box clears it', () => {
		const r = resolveBuildingCollision(0, 11, 0, [box]);
		expect(r).toEqual({ x: 0, z: 0 });
	});
});

describe('interaction prompt', () => {
	const citizens = [
		{ id: 'a', kind: 'citizen', x: 2, z: 0 },
		{ id: 'b', kind: 'citizen', x: 0, z: 2.5 },
		{ id: 'far', kind: 'citizen', x: 40, z: 40 },
	];

	it('picks the nearest candidate within reach', () => {
		const hit = nearestInteractable(0, 0, citizens);
		expect(hit.id).toBe('a');
		expect(hit.distance).toBeCloseTo(2, 5);
	});

	it('returns null when nothing is in range', () => {
		expect(nearestInteractable(100, 100, citizens)).toBe(null);
		expect(nearestInteractable(0, 0, [])).toBe(null);
	});

	it('respects the interact radius boundary', () => {
		const edge = [{ id: 'edge', kind: 'citizen', x: INTERACT_RADIUS + 0.01, z: 0 }];
		expect(nearestInteractable(0, 0, edge)).toBe(null);
		const inside = [{ id: 'in', kind: 'citizen', x: INTERACT_RADIUS - 0.01, z: 0 }];
		expect(nearestInteractable(0, 0, inside)?.id).toBe('in');
	});
});

describe('open-ground spawn (walk-to-NPC reachability)', () => {
	const town = [
		{ minX: -2, maxX: 2, minZ: -2, maxZ: 2, h: 40 }, // a tower straddling the origin
		{ minX: 5, maxX: 9, minZ: 5, maxZ: 9, h: 30 },
	];

	it('detects ground inside vs clear of buildings', () => {
		expect(isOpenGround(0, 0, town)).toBe(false); // dead centre of the tower
		expect(isOpenGround(1.9, 0, town)).toBe(false); // within the margin of a face
		expect(isOpenGround(20, 20, town)).toBe(true); // open street
		expect(isOpenGround(0, 0, [])).toBe(true); // no buildings → all open
	});

	it('nudges a walled spawn out to the nearest open point', () => {
		const spawn = findOpenSpawn({ x: 0, z: 0 }, town);
		expect(isOpenGround(spawn.x, spawn.z, town)).toBe(true);
		// It stays near the desired spot, not flung across the map.
		expect(Math.hypot(spawn.x, spawn.z)).toBeLessThan(12);
	});

	it('leaves an already-open spawn untouched', () => {
		const spawn = findOpenSpawn({ x: 20, z: 20 }, town);
		expect(spawn).toEqual({ x: 20, z: 20 });
	});

	it('degenerates gracefully to the desired point when nowhere is open', () => {
		const walled = [{ minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, h: 5 }];
		const spawn = findOpenSpawn({ x: 3, z: 4 }, walled, { maxRadius: 20 });
		expect(spawn).toEqual({ x: 3, z: 4 }); // never leaves the player unplaced
	});

	it('the open point clears collision push-out (player can actually stand there)', () => {
		const spawn = findOpenSpawn({ x: 0, z: 0 }, town);
		const resolved = resolveBuildingCollision(spawn.x, 0, spawn.z, town, PLAYER_RADIUS);
		// A truly open point isn't pushed anywhere by the collision solver.
		expect(Math.hypot(resolved.x - spawn.x, resolved.z - spawn.z)).toBeLessThan(1e-9);
	});
});

describe('avatar source resolution', () => {
	const params = (obj) => ({ get: (k) => obj[k] ?? null });

	it('prefers a direct url, then an id, then storage, then default', () => {
		const store = (k) => (k === 'agora:avatar' ? 'stored-id' : null);
		expect(chooseAvatarSource(params({ avatarUrl: 'https://x/a.glb', avatar: 'id1' }), store))
			.toEqual({ source: 'param-url', value: 'https://x/a.glb' });
		expect(chooseAvatarSource(params({ avatar: 'id1' }), store))
			.toEqual({ source: 'param', value: 'id1' });
		expect(chooseAvatarSource(params({}), store))
			.toEqual({ source: 'stored', value: 'stored-id' });
		expect(chooseAvatarSource(params({}), () => null))
			.toEqual({ source: 'default', value: '' });
	});
});

describe('guest identity', () => {
	it('keeps a stored name; derives a stable tag otherwise', () => {
		expect(guestName(() => ' Aria ', 0.5)).toBe('Aria');
		const fresh = guestName(() => null, 0.5);
		expect(fresh).toMatch(/^visitor-[0-9a-z]{3}$/);
		expect(guestName(() => null, 0.5)).toBe(fresh); // same entropy → same tag
	});
});
