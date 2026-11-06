// GPS-edge hysteresis band for nearby-agent membership (src/irl/proximity-band.js).
//
// These tests pin the contract that kills edge flicker: an agent on the discovery
// boundary, with consumer GPS jittering ±10 m, must NOT pop in and out. The policy is
// pure (distance + a few flags in, one action out), so the whole enter/exit/debounce
// band is proven here with no DOM, no Three.js, and no real clock — exactly the shape
// loadNearbyPins() drives each 10 s poll.

import { describe, it, expect } from 'vitest';

import {
	ENTER_RADIUS_M,
	EXIT_RADIUS_M,
	DROP_POLLS,
	pinBandAction,
} from '../src/irl/proximity-band.js';

// Mirror of how loadNearbyPins() threads the per-pin debounce counter: feed a series
// of (distance, listed) polls through the band and collect the actions, carrying the
// rendered flag + oobPolls forward exactly as the real reconcile loop does. Returns
// the action sequence, whether the pin was ever disposed, and how many "newly stable
// in-range" arrival signals fired — loadNearbyPins() calls emitPinStable(entry) on
// exactly the 'spawn' action, so arrivals === the count of 'spawn's. Task 03's
// proximity-arrival cue consumes that signal, so this count IS its no-double-fire
// guarantee under GPS-edge jitter.
function runPolls(initialRendered, polls, opts) {
	let rendered = initialRendered;
	let oobPolls = 0;
	const actions = [];
	let arrivals = 0;
	for (const { distance, listed = true } of polls) {
		const action = pinBandAction({ distance, rendered, listed, oobPolls }, opts);
		actions.push(action);
		if (action === 'spawn') { rendered = true; oobPolls = 0; arrivals += 1; }
		else if (action === 'keep') { oobPolls = 0; }
		else if (action === 'wait') { oobPolls += 1; }
		else if (action === 'drop') { rendered = false; oobPolls = 0; }
		// 'ignore' leaves an unrendered pin unrendered
	}
	return { actions, disposed: actions.includes('drop'), arrivals };
}

describe('band constants', () => {
	it('exit is strictly beyond enter so the band has width to absorb jitter', () => {
		expect(EXIT_RADIUS_M).toBeGreaterThan(ENTER_RADIUS_M);
		// The 15 m band must clear ±10 m noise at the 40 m edge without touching exit.
		expect(EXIT_RADIUS_M - ENTER_RADIUS_M).toBeGreaterThanOrEqual(10);
	});
	it('drop takes more than one poll (debounce is real)', () => {
		expect(DROP_POLLS).toBeGreaterThanOrEqual(2);
	});
});

describe('enter gate (discovery)', () => {
	it('spawns an unrendered, listed pin once within the enter radius', () => {
		expect(pinBandAction({ distance: 39, rendered: false, listed: true })).toBe('spawn');
		expect(pinBandAction({ distance: ENTER_RADIUS_M, rendered: false, listed: true })).toBe('spawn');
	});
	it('ignores an unrendered pin still outside the enter radius — no drift-in discovery', () => {
		expect(pinBandAction({ distance: 41, rendered: false, listed: true })).toBe('ignore');
		// A pin sitting in the 40–55 m hysteresis band is never DISCOVERED there; you
		// only enter it by getting within 40 m, then it's held out to exit.
		expect(pinBandAction({ distance: 50, rendered: false, listed: true })).toBe('ignore');
	});
	it('never spawns from a pin the server did not return', () => {
		expect(pinBandAction({ distance: 10, rendered: false, listed: false })).toBe('ignore');
	});
});

describe('keep band (rendered, in-band)', () => {
	it('keeps a rendered pin anywhere inside the exit radius', () => {
		expect(pinBandAction({ distance: 5,  rendered: true, listed: true })).toBe('keep');
		expect(pinBandAction({ distance: 45, rendered: true, listed: true })).toBe('keep');
		expect(pinBandAction({ distance: EXIT_RADIUS_M, rendered: true, listed: true })).toBe('keep');
	});
	it('keeping resets the out-of-band debounce', () => {
		// One bad poll (out-of-band) then back in-band must clear the counter so a later
		// single bad poll can never accumulate into a drop.
		const { actions, disposed } = runPolls(true, [
			{ distance: 58 }, // out → wait (oob 0→1)
			{ distance: 50 }, // back in → keep (oob reset)
			{ distance: 58 }, // out → wait (oob 0→1 again, NOT 2)
			{ distance: 50 }, // back in → keep
		]);
		expect(actions).toEqual(['wait', 'keep', 'wait', 'keep']);
		expect(disposed).toBe(false);
	});
});

describe('±10 m GPS jitter at the boundary — the headline bug', () => {
	it('a pin held at ~40 m with ±10 m noise never disposes/respawns', () => {
		// 12 polls of a pin physically at 40 m, GPS noise pushing the client distance
		// across 30–50 m. It is always listed (server read radius is the 60 m cap) and
		// always inside the 55 m exit, so every poll is 'keep' — zero churn.
		const noisy = [40, 50, 31, 47, 38, 49, 30, 45, 42, 50, 33, 48]
			.map(distance => ({ distance, listed: true }));
		const { actions, disposed } = runPolls(true, noisy);
		expect(disposed).toBe(false);
		expect(actions.every(a => a === 'keep')).toBe(true);
	});

	it('a brief one-poll excursion past exit does not evict', () => {
		// Standing right at the edge, a single noisy fix briefly reads 57 m, then settles.
		const { disposed } = runPolls(true, [
			{ distance: 52 }, { distance: 57 }, { distance: 51 }, { distance: 49 },
		]);
		expect(disposed).toBe(false);
	});
});

describe('debounced exit (genuine departure)', () => {
	it('requires DROP_POLLS sustained out-of-band polls before dropping', () => {
		// Walk away: client distance climbs past exit and stays there.
		const { actions } = runPolls(true, [
			{ distance: 58 }, // wait  (oob → 1)
			{ distance: 62 }, // drop  (oob 1, +1 ≥ DROP_POLLS=2)
		]);
		expect(actions).toEqual(['wait', 'drop']);
	});

	it('drops a deleted pin even at point-blank range (server stops listing it)', () => {
		// Owner deletes / hides the agent: distance is tiny but the server no longer
		// returns it, so it is out-of-band by membership, not distance — and clears.
		const { actions, disposed } = runPolls(true, [
			{ distance: 4, listed: false }, // wait
			{ distance: 4, listed: false }, // drop
		]);
		expect(actions).toEqual(['wait', 'drop']);
		expect(disposed).toBe(true);
	});

	it('drops a pin that walked far past the server cap', () => {
		const { disposed } = runPolls(true, [
			{ distance: 80, listed: false },
			{ distance: 90, listed: false },
		]);
		expect(disposed).toBe(true);
	});
});

describe('options override the band', () => {
	it('honours custom enter/exit/dropPolls thresholds', () => {
		const opts = { enter: 20, exit: 30, dropPolls: 3 };
		expect(pinBandAction({ distance: 25, rendered: false, listed: true }, opts)).toBe('ignore');
		expect(pinBandAction({ distance: 18, rendered: false, listed: true }, opts)).toBe('spawn');
		expect(pinBandAction({ distance: 28, rendered: true, listed: true }, opts)).toBe('keep');
		// Needs three sustained out-of-band polls now, not two.
		const { actions } = runPolls(true, [
			{ distance: 35 }, { distance: 35 }, { distance: 35 },
		], opts);
		expect(actions).toEqual(['wait', 'wait', 'drop']);
	});
});

// The "newly stable in-range" signal task 03 consumes. loadNearbyPins() fires
// emitPinStable(entry) on exactly the band's 'spawn' action — so arrival count ==
// 'spawn' count. These tests pin the contract the arrival cue depends on: one
// signal per genuine arrival, ZERO during edge jitter, and a fresh signal only
// after a genuine departure + return.
describe('newly-stable-in-range arrival signal (→ task 03)', () => {
	it('fires exactly once when a pin first crosses the enter gate', () => {
		// Approach from outside: ignored beyond enter, one arrival on the gate cross,
		// then steady keeps that must not re-fire.
		const { arrivals, actions } = runPolls(false, [
			{ distance: 50 }, // ignore — outside enter, not discovered by drifting near
			{ distance: 38 }, // spawn  — crossed the 40 m gate → ONE arrival
			{ distance: 36 }, // keep
			{ distance: 41 }, // keep   — inside exit (55), still rendered
		]);
		expect(actions).toEqual(['ignore', 'spawn', 'keep', 'keep']);
		expect(arrivals).toBe(1);
	});

	it('does NOT fire while a steady pin jitters ±10 m at the 40 m edge', () => {
		// The headline bug, viewed from the cue's seat: a pin physically at 40 m with
		// noisy fixes is one arrival on first discovery and then pure keeps — the cue
		// must never re-buzz the user on every wobble.
		const first = runPolls(false, [{ distance: 39 }]); // discovered once
		expect(first.arrivals).toBe(1);
		const noisy = [40, 50, 31, 47, 38, 49, 30, 45, 42, 50, 33, 48]
			.map(distance => ({ distance, listed: true }));
		const after = runPolls(true, noisy); // already rendered → all keeps
		expect(after.arrivals).toBe(0);
		expect(after.actions.every(a => a === 'keep')).toBe(true);
	});

	it('re-fires only after a genuine departure and return', () => {
		// Walk in (arrival), walk away past exit until debounce drops it, then walk
		// back in — that second discovery is a real, separate arrival and SHOULD fire.
		const { arrivals, actions } = runPolls(false, [
			{ distance: 35 },                 // spawn  → arrival 1
			{ distance: 60 },                 // wait
			{ distance: 65 },                 // drop   (gone)
			{ distance: 65, listed: false },  // ignore (not listed, not rendered)
			{ distance: 30 },                 // spawn  → arrival 2 (genuine return)
		]);
		expect(actions).toEqual(['spawn', 'wait', 'drop', 'ignore', 'spawn']);
		expect(arrivals).toBe(2);
	});

	it('does not fire for a pin that merely refreshed in place', () => {
		// A rendered pin getting fresh server rows every poll (rename/calibrate) stays
		// 'keep' — refreshKnownPin handles the data, the band emits nothing.
		const { arrivals } = runPolls(true, [
			{ distance: 12 }, { distance: 13 }, { distance: 11 }, { distance: 14 },
		]);
		expect(arrivals).toBe(0);
	});
});
