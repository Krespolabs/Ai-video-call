// Tap picking — label-net ranking (src/irl/tap-pick.js).
//
// Inspecting an agent is the primary IRL interaction, so the fallback that catches
// taps the body-mesh ray misses — the finger-sized "label net" — has to behave
// predictably on a phone: a tap *near* a label still selects it (fat-finger), a tap
// outside every label's reach selects nothing, off-screen agents are never picked,
// and when the finger lands on a cluster the agent in FRONT of the viewer wins. The
// device feel of that is unrepeatable by hand; the math is pinned here.

import { describe, it, expect } from 'vitest';

import { pickLabelHit, TAP_SLOP_PX, TIE_BAND_PX } from '../src/irl/tap-pick.js';

const label = (sx, sy, distance, tag) => ({ sx, sy, distance, tag });

describe('pickLabelHit', () => {
	it('returns null when no candidates are within slop', () => {
		const cands = [label(0, 0, 5, 'a'), label(500, 500, 3, 'b')];
		expect(pickLabelHit(cands, 200, 200)).toBe(null);
	});

	it('returns null for an empty candidate set', () => {
		expect(pickLabelHit([], 10, 10)).toBe(null);
	});

	it('selects a label the finger lands on but slightly outside its box (fat-finger)', () => {
		// Finger is TAP_SLOP_PX-ish away — still a hit.
		const c = label(100, 100, 8, 'near');
		const hit = pickLabelHit([c], 100 + (TAP_SLOP_PX - 4), 100);
		expect(hit).toBe(c);
	});

	it('rejects a tap just beyond the slop radius', () => {
		const c = label(100, 100, 8, 'near');
		expect(pickLabelHit([c], 100 + TAP_SLOP_PX + 2, 100)).toBe(null);
	});

	it('picks the clear pixel winner when one label is distinctly closer to the finger', () => {
		const near = label(100, 100, 50, 'near-finger'); // farther agent, but under the finger
		const far  = label(120, 100, 1, 'far-finger');   // closest agent, but 20px from finger
		// 20px gap >> TIE_BAND_PX, so finger proximity decides — not viewer distance.
		expect(pickLabelHit([near, far], 100, 100)).toBe(near);
	});

	it('breaks a cluster tie toward the agent nearest the viewer (front wins)', () => {
		// Both labels essentially under the finger (within TIE_BAND_PX); the nearer
		// agent (smaller distance) must win regardless of array order.
		const front = label(101, 100, 2, 'front');
		const back  = label(100, 101, 40, 'back');
		expect(pickLabelHit([back, front], 100, 100).tag).toBe('front');
		expect(pickLabelHit([front, back], 100, 100).tag).toBe('front');
	});

	it('never selects an off-screen candidate', () => {
		const off = { sx: 100, sy: 100, distance: 1, onScreen: false, tag: 'off' };
		const on  = label(140, 100, 30, 'on'); // within slop of a tap at (118,100)
		expect(pickLabelHit([off], 100, 100)).toBe(null);
		expect(pickLabelHit([off, on], 118, 100).tag).toBe('on');
	});

	it('skips candidates with a non-finite screen centre (not laid out this frame)', () => {
		const bad = { sx: NaN, sy: NaN, distance: 1, tag: 'bad' };
		const good = label(105, 100, 9, 'good');
		expect(pickLabelHit([bad, good], 100, 100).tag).toBe('good');
	});

	it('treats a non-finite viewer distance as farthest in a tie', () => {
		const known   = label(100, 100, 4, 'known');
		const unknown = label(101, 100, undefined, 'unknown');
		expect(pickLabelHit([unknown, known], 100, 100).tag).toBe('known');
	});

	it('returns null for a non-finite tap position', () => {
		const c = label(100, 100, 1, 'a');
		expect(pickLabelHit([c], NaN, 100)).toBe(null);
		expect(pickLabelHit([c], 100, undefined)).toBe(null);
	});

	it('exposes sane default constants', () => {
		expect(TAP_SLOP_PX).toBeGreaterThan(0);
		expect(TIE_BAND_PX).toBeGreaterThan(0);
		expect(TIE_BAND_PX).toBeLessThan(TAP_SLOP_PX);
	});
});
