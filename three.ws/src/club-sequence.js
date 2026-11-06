// Sequence playback for the Pole Club stage.
//
// A dance "ticket" returned by /api/x402/dance-tip carries either a single
// `clip` (free-floor styles) or a `sequence` array (pole choreography:
// spin / climb / combo). `playSequence` consumes both shapes uniformly so
// PoleStation doesn't need to branch.
//
// The module is deliberately framework-light — no THREE imports, no DOM
// access — so it can be unit-tested without spinning up a WebGLRenderer.

/**
 * Real-clock sleep. Resolves after `ms` milliseconds of wall time, which is
 * the same clock `tick()` uses (`Date.now()` / `clock.getElapsedTime()`). The
 * render loop keeps ticking the mixer in the background; this only awaits
 * the elapsed time before kicking off the next crossfade.
 *
 * Not a fake setTimeout-driven progress bar — it's a real wait that yields
 * back to the event loop until the timer fires. Tests can inject a stub
 * via the `sleep` option on `playSequence` to step through deterministically.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a ticket into a list of `{ clip, durationSec }` steps.
 *
 * Sequence-shaped tickets pass through untouched. Single-clip tickets are
 * lifted into a 1-step sequence. Anything else returns an empty array, which
 * `playSequence` treats as a no-op (so unknown tickets fail closed rather
 * than crashing).
 *
 * @param {{ sequence?: Array<{clip:string, durationSec:number}>, clip?: string, durationSec?: number }} ticket
 * @returns {Array<{ clip: string, durationSec: number }>}
 */
export function ticketSteps(ticket) {
	if (Array.isArray(ticket?.sequence) && ticket.sequence.length) {
		return ticket.sequence.map((s) => ({
			clip: String(s.clip),
			durationSec: Number(s.durationSec) || 0,
		}));
	}
	if (ticket?.clip) {
		return [{ clip: String(ticket.clip), durationSec: Number(ticket?.durationSec) || 0 }];
	}
	return [];
}

/**
 * Drive a sequence of crossfades on the supplied AnimationManager-shaped
 * object. Each step:
 *   1. await anim.crossfadeTo(step.clip, fadeSec)
 *   2. await sleep(step.durationSec * 1000)
 *
 * The loop checks `isCancelled()` between steps and aborts before the next
 * crossfade — matches the contract in the task spec
 * ("setting performing = false mid-sequence stops the next crossfade").
 *
 * @param {object}   args
 * @param {{ crossfadeTo: (name: string, fade?: number) => Promise<void> }} args.anim
 *        Animation manager. Only `crossfadeTo` is required.
 * @param {Array<{ clip: string, durationSec: number }>} args.steps
 *        The sequence to play. Use `ticketSteps(ticket)` to derive from a tip ticket.
 * @param {number}   [args.fadeSec=0.45]
 *        Crossfade duration passed to anim.crossfadeTo.
 * @param {() => boolean} [args.isCancelled]
 *        Polled between steps; truthy aborts the loop before the next crossfade.
 * @param {(ms: number) => Promise<void>} [args.sleep]
 *        Real-clock wait between steps. Defaults to the module's `sleep`.
 *        Tests inject a deterministic stub here.
 * @returns {Promise<{ played: number, cancelled: boolean }>}
 *          `played` = number of steps that ran a crossfade (cancellation
 *          before the first crossfade counts as 0).
 */
export async function playSequence({
	anim,
	steps,
	fadeSec = 0.45,
	isCancelled = () => false,
	sleep: sleepFn = sleep,
}) {
	let played = 0;
	for (const step of steps) {
		if (isCancelled()) return { played, cancelled: true };
		await anim.crossfadeTo(step.clip, fadeSec);
		played += 1;
		if (step.durationSec > 0) {
			await sleepFn(step.durationSec * 1000);
		}
	}
	return { played, cancelled: false };
}
