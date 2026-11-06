// Tests for src/club-sequence.js — the sequence-playback driver used by
// PoleStation. The module is framework-light (no THREE imports, no DOM) so
// these run as pure unit tests with a stub AnimationManager.

import { describe, it, expect, vi } from 'vitest';
import { playSequence, ticketSteps, sleep } from '../src/club-sequence.js';

function makeAnim() {
	const calls = [];
	return {
		calls,
		async crossfadeTo(name, fade) {
			calls.push({ name, fade });
		},
	};
}

describe('ticketSteps', () => {
	it('passes through a sequence ticket as-is, coerced to clean shape', () => {
		const steps = ticketSteps({
			sequence: [
				{ clip: 'pole-spin', durationSec: 8 },
				{ clip: 'pole-bow',  durationSec: 2 },
			],
		});
		expect(steps).toEqual([
			{ clip: 'pole-spin', durationSec: 8 },
			{ clip: 'pole-bow',  durationSec: 2 },
		]);
	});

	it('lifts a single-clip ticket into a 1-step sequence', () => {
		const steps = ticketSteps({ clip: 'rumba', durationSec: 14 });
		expect(steps).toEqual([{ clip: 'rumba', durationSec: 14 }]);
	});

	it('returns [] for an empty/unknown ticket so callers fail closed', () => {
		expect(ticketSteps(null)).toEqual([]);
		expect(ticketSteps(undefined)).toEqual([]);
		expect(ticketSteps({})).toEqual([]);
	});

	it('ignores empty sequence arrays and falls through to clip fallback', () => {
		const steps = ticketSteps({ sequence: [], clip: 'dance', durationSec: 12 });
		expect(steps).toEqual([{ clip: 'dance', durationSec: 12 }]);
	});

	it('coerces non-number durations to 0 rather than NaN', () => {
		const steps = ticketSteps({
			sequence: [{ clip: 'pole-bow', durationSec: 'two' }],
		});
		expect(steps).toEqual([{ clip: 'pole-bow', durationSec: 0 }]);
	});
});

describe('playSequence — happy path', () => {
	it('calls crossfadeTo in declared order with the configured fade duration', async () => {
		const anim = makeAnim();
		const sleepCalls = [];
		const stubSleep = (ms) => { sleepCalls.push(ms); return Promise.resolve(); };

		const result = await playSequence({
			anim,
			steps: [
				{ clip: 'pole-spin', durationSec: 8 },
				{ clip: 'pole-bow',  durationSec: 2 },
			],
			fadeSec: 0.45,
			sleep: stubSleep,
		});

		expect(anim.calls).toEqual([
			{ name: 'pole-spin', fade: 0.45 },
			{ name: 'pole-bow',  fade: 0.45 },
		]);
		// One sleep per step, each step's duration in ms.
		expect(sleepCalls).toEqual([8000, 2000]);
		expect(result).toEqual({ played: 2, cancelled: false });
	});

	it('skips the sleep when durationSec is 0', async () => {
		const anim = makeAnim();
		const stubSleep = vi.fn(() => Promise.resolve());

		await playSequence({
			anim,
			steps: [
				{ clip: 'a', durationSec: 0 },
				{ clip: 'b', durationSec: 1 },
			],
			sleep: stubSleep,
		});

		// First step's 0-sec duration skips the sleep entirely; second step sleeps.
		expect(stubSleep).toHaveBeenCalledTimes(1);
		expect(stubSleep).toHaveBeenCalledWith(1000);
	});

	it('returns played=0 / cancelled=false for an empty step list', async () => {
		const anim = makeAnim();
		const result = await playSequence({ anim, steps: [], sleep: () => Promise.resolve() });
		expect(anim.calls).toEqual([]);
		expect(result).toEqual({ played: 0, cancelled: false });
	});
});

describe('playSequence — cancellation', () => {
	it('stops before the next crossfade when isCancelled flips true', async () => {
		const anim = makeAnim();
		let cancelled = false;
		// Each sleep resolves immediately, but flips the cancellation flag the
		// first time it runs — mirroring "performing = false" being set mid-
		// sequence by the user closing the page / refunding / etc.
		const stubSleep = vi.fn(() => {
			cancelled = true;
			return Promise.resolve();
		});

		const result = await playSequence({
			anim,
			steps: [
				{ clip: 'pole-spin',  durationSec: 4 },
				{ clip: 'pole-climb', durationSec: 4 },
				{ clip: 'pole-bow',   durationSec: 2 },
			],
			isCancelled: () => cancelled,
			sleep: stubSleep,
		});

		// Only the first crossfade ran; cancellation fired during its sleep,
		// so the loop bailed before crossfading to pole-climb.
		expect(anim.calls).toEqual([{ name: 'pole-spin', fade: 0.45 }]);
		expect(result).toEqual({ played: 1, cancelled: true });
	});

	it('reports cancelled=true without any crossfades when cancelled before the first step', async () => {
		const anim = makeAnim();
		const result = await playSequence({
			anim,
			steps: [
				{ clip: 'pole-spin', durationSec: 4 },
				{ clip: 'pole-bow',  durationSec: 2 },
			],
			isCancelled: () => true,
			sleep: () => Promise.resolve(),
		});
		expect(anim.calls).toEqual([]);
		expect(result).toEqual({ played: 0, cancelled: true });
	});

	it('does not call the next crossfade while a long sleep is still pending', async () => {
		// Simulates the real PoleStation scenario: an in-flight sleep hasn't
		// resolved yet, so the next crossfade hasn't been issued. Cancellation
		// will be observed when the sleep eventually resolves and the loop
		// re-enters the isCancelled() check.
		const anim = makeAnim();
		let resolveSleep;
		const pendingSleep = new Promise((r) => { resolveSleep = r; });
		const stubSleep = vi.fn(() => pendingSleep);

		let cancelled = false;
		const seqPromise = playSequence({
			anim,
			steps: [
				{ clip: 'pole-spin', durationSec: 8 },
				{ clip: 'pole-bow',  durationSec: 2 },
			],
			isCancelled: () => cancelled,
			sleep: stubSleep,
		});

		// Yield once so the first crossfade + sleep call settle.
		await Promise.resolve();
		expect(anim.calls).toEqual([{ name: 'pole-spin', fade: 0.45 }]);
		expect(stubSleep).toHaveBeenCalledTimes(1);

		// Cancel mid-sleep, then let the sleep finally resolve.
		cancelled = true;
		resolveSleep();

		const result = await seqPromise;
		expect(anim.calls).toEqual([{ name: 'pole-spin', fade: 0.45 }]);
		expect(result).toEqual({ played: 1, cancelled: true });
	});
});

describe('sleep — module default', () => {
	it('resolves immediately for non-positive durations', async () => {
		const t0 = Date.now();
		await Promise.all([sleep(0), sleep(-5), sleep(NaN)]);
		// Should be effectively zero wall time — sub-millisecond resolution.
		expect(Date.now() - t0).toBeLessThan(50);
	});

	it('actually waits the requested duration for positive values', async () => {
		const t0 = Date.now();
		await sleep(40);
		const elapsed = Date.now() - t0;
		// 40ms wait — give a generous lower bound to avoid timing flake on
		// busy CI workers, and a wide upper bound to absorb scheduler jitter.
		expect(elapsed).toBeGreaterThanOrEqual(30);
		expect(elapsed).toBeLessThan(500);
	});
});
