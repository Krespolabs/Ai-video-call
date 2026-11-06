// Proximity-arrival cue policy (src/irl/proximity-cue.js).
//
// The cue is the delight that makes a list-less, radar-less discovery model feel
// alive instead of dead: a haptic + chime + "look around" banner + an edge glow
// that points toward the nearest off-screen agent and fades once you turn to face
// it. All of that rides on this pure policy. These tests pin the two contracts the
// privacy model leans on — (1) the cue is rate-limited so a busy spot can't slot-
// machine the user, and (2) the directional math points a *direction* derived from
// the world offset the viewer already renders, never a coordinate, and tracks the
// agent live as the device rotates, fading the moment the agent is on-screen.

import { describe, it, expect } from 'vitest';

import {
	CUE_COOLDOWN_MS,
	shouldCueArrival,
	normalizeAngle,
	relativeBearing,
	isFacingAgent,
	edgeNudgePlacement,
	nearestAgent,
} from '../src/irl/proximity-cue.js';

describe('shouldCueArrival — global cooldown (no slot machine)', () => {
	it('fires the very first arrival (no prior cue)', () => {
		expect(shouldCueArrival(1000, null)).toBe(true);
		expect(shouldCueArrival(1000, undefined)).toBe(true);
	});

	it('suppresses a second arrival inside the cooldown window', () => {
		const t0 = 100000;
		expect(shouldCueArrival(t0, null)).toBe(true);
		// Ten agents drift in over the next few seconds — the band emits ten arrival
		// signals, but the user feels exactly one buzz until the cooldown lapses.
		expect(shouldCueArrival(t0 + 1000, t0)).toBe(false);
		expect(shouldCueArrival(t0 + CUE_COOLDOWN_MS - 1, t0)).toBe(false);
	});

	it('allows the next cue once the full cooldown has elapsed', () => {
		const t0 = 100000;
		expect(shouldCueArrival(t0 + CUE_COOLDOWN_MS, t0)).toBe(true);
		expect(shouldCueArrival(t0 + CUE_COOLDOWN_MS + 5000, t0)).toBe(true);
	});

	it('honours a custom cooldown override', () => {
		expect(shouldCueArrival(2000, 1000, 2000)).toBe(false);
		expect(shouldCueArrival(3000, 1000, 2000)).toBe(true);
	});

	it('never fires on a non-finite clock (defensive)', () => {
		expect(shouldCueArrival(NaN, null)).toBe(false);
		expect(shouldCueArrival(Infinity, null)).toBe(false);
	});

	it('treats a corrupt lastCueAt as "no prior cue" rather than blocking forever', () => {
		expect(shouldCueArrival(5000, NaN)).toBe(true);
	});
});

describe('normalizeAngle — shortest-turn wrapping', () => {
	it('leaves an in-range angle untouched', () => {
		expect(normalizeAngle(0)).toBe(0);
		expect(normalizeAngle(Math.PI / 4)).toBeCloseTo(Math.PI / 4, 10);
	});

	it('wraps past +π to the negative equivalent (shortest turn)', () => {
		// 270° clockwise is really 90° counter-clockwise.
		expect(normalizeAngle((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 10);
	});

	it('wraps a large multi-turn angle back into (-π, π]', () => {
		expect(normalizeAngle(Math.PI * 4 + 0.3)).toBeCloseTo(0.3, 10);
		expect(normalizeAngle(-Math.PI * 4 - 0.3)).toBeCloseTo(-0.3, 10);
	});
});

describe('relativeBearing — which way to turn (from a world offset, not coords)', () => {
	// Frame: +x screen-right, -z forward (camera looks down -z), cameraYaw 0 = ahead.
	it('reads 0 when the agent is dead ahead and the camera faces forward', () => {
		expect(relativeBearing(0, -10, 0)).toBeCloseTo(0, 6);
	});

	it('reads +π/2 (turn right) for an agent directly to the screen-right', () => {
		expect(relativeBearing(10, 0, 0)).toBeCloseTo(Math.PI / 2, 6);
	});

	it('reads -π/2 (turn left) for an agent directly to the screen-left', () => {
		expect(relativeBearing(-10, 0, 0)).toBeCloseTo(-Math.PI / 2, 6);
	});

	it('reads ±π for an agent directly behind the viewer', () => {
		expect(Math.abs(relativeBearing(0, 10, 0))).toBeCloseTo(Math.PI, 6);
	});

	it('tracks the agent live as the user rotates the camera', () => {
		// Agent fixed dead-ahead in the world; rotating the camera 90° right means the
		// agent is now 90° to the LEFT of the new view — the nudge must follow.
		const ahead = relativeBearing(0, -10, 0);
		const turnedRight = relativeBearing(0, -10, Math.PI / 2);
		expect(ahead).toBeCloseTo(0, 6);
		expect(turnedRight).toBeCloseTo(-Math.PI / 2, 6);
	});
});

describe('isFacingAgent — fade the nudge once the agent is on screen', () => {
	const halfFov = (70 * Math.PI) / 180 / 2; // ~35° half-FOV

	it('is true when the agent sits near the centre of the view cone', () => {
		expect(isFacingAgent(0, halfFov)).toBe(true);
		expect(isFacingAgent(halfFov * 0.5, halfFov)).toBe(true);
	});

	it('is false when the agent is outside the (inset) view cone — keep nudging', () => {
		expect(isFacingAgent(halfFov, halfFov)).toBe(false);       // exactly at the edge
		expect(isFacingAgent(Math.PI, halfFov)).toBe(false);       // directly behind
		expect(isFacingAgent(halfFov * 0.86, halfFov)).toBe(false); // just past the 0.85 inset
	});

	it('rejects non-finite inputs defensively', () => {
		expect(isFacingAgent(NaN, halfFov)).toBe(false);
		expect(isFacingAgent(0, NaN)).toBe(false);
	});
});

describe('edgeNudgePlacement — stable for the full ±π range (no projection flip)', () => {
	const W = 390;
	const H = 844; // iPhone-ish portrait
	const inset = 34;

	it('rides the top edge when the agent is dead ahead', () => {
		const { x, y, rotateDeg } = edgeNudgePlacement(0, W, H, inset);
		expect(x).toBeCloseTo(W / 2, 6);          // centred horizontally
		expect(y).toBeCloseTo(inset, 6);          // pinned to the top safe edge
		expect(rotateDeg).toBeCloseTo(0, 6);      // arrow points straight up
	});

	it('rides the right edge and points right when the agent is to the right', () => {
		const { x, y, rotateDeg } = edgeNudgePlacement(Math.PI / 2, W, H, inset);
		expect(x).toBeCloseTo(W - inset, 6);
		expect(y).toBeCloseTo(H / 2, 6);
		expect(rotateDeg).toBeCloseTo(90, 6);
	});

	it('rides the left edge and points left when the agent is to the left', () => {
		const { x, y, rotateDeg } = edgeNudgePlacement(-Math.PI / 2, W, H, inset);
		expect(x).toBeCloseTo(inset, 6);
		expect(y).toBeCloseTo(H / 2, 6);
		expect(rotateDeg).toBeCloseTo(-90, 6);
	});

	it('rides the bottom edge and points down when the agent is behind (the key case)', () => {
		// The whole point of the cue: the agent is BEHIND you. Projection would flip
		// here; the bearing→ellipse map stays sane and tells you to look back/down.
		const { x, y, rotateDeg } = edgeNudgePlacement(Math.PI, W, H, inset);
		expect(x).toBeCloseTo(W / 2, 6);
		expect(y).toBeCloseTo(H - inset, 6);
		expect(Math.abs(rotateDeg)).toBeCloseTo(180, 6);
	});

	it('keeps the glow inside the safe-inset viewport for every bearing', () => {
		for (let deg = -180; deg <= 180; deg += 7) {
			const { x, y } = edgeNudgePlacement((deg * Math.PI) / 180, W, H, inset);
			expect(x).toBeGreaterThanOrEqual(inset - 1e-6);
			expect(x).toBeLessThanOrEqual(W - inset + 1e-6);
			expect(y).toBeGreaterThanOrEqual(inset - 1e-6);
			expect(y).toBeLessThanOrEqual(H - inset + 1e-6);
		}
	});

	it('never collapses the ellipse on a tiny viewport', () => {
		const { x, y } = edgeNudgePlacement(Math.PI / 3, 40, 40, 34);
		expect(Number.isFinite(x)).toBe(true);
		expect(Number.isFinite(y)).toBe(true);
	});
});

describe('nearestAgent — one clear "that way", never a cluster of arrows', () => {
	it('returns the closest of several in-range agents', () => {
		const agents = [
			{ id: 'a', distance: 22 },
			{ id: 'b', distance: 9 },
			{ id: 'c', distance: 31 },
		];
		expect(nearestAgent(agents).id).toBe('b');
	});

	it('returns null for an empty set', () => {
		expect(nearestAgent([])).toBeNull();
	});

	it('skips entries with a non-finite distance', () => {
		const agents = [
			{ id: 'x', distance: NaN },
			{ id: 'y', distance: 14 },
		];
		expect(nearestAgent(agents).id).toBe('y');
	});

	it('returns null when no entry has a usable distance', () => {
		expect(nearestAgent([{ id: 'x' }, { id: 'y', distance: NaN }])).toBeNull();
	});
});
