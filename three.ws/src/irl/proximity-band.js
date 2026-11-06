// GPS-edge hysteresis for nearby-agent membership (IRL task 04).
//
// Consumer GPS is ~5–30 m noisy and the "stumble upon" discovery gate is tight
// (40 m), so an agent sitting on the boundary would otherwise cross the threshold
// on *every* fix — the server returns it, drops it, returns it — and the viewer
// watches the avatar spawn, dispose its GPU resources, and respawn on repeat. The
// origin low-pass (blendOrigin) smooths the *viewer* origin but does nothing for
// *set membership* churn at the edge. This module is that missing piece.
//
// It is the PURE membership policy: given a pin's client-computed distance, whether
// it's already rendered, whether the server still lists it, and how many consecutive
// polls it's been out-of-band, it returns exactly one action. No DOM, no Three.js,
// no clock — so the band (enter / exit / debounce) is proven in a unit test.
//
// Two ideas, both local so they hold regardless of the server's coarse set:
//   1. Asymmetric band. A pin only ENTERS once it's within ENTER_RADIUS_M, but once
//      rendered it's KEPT until it clearly leaves (EXIT_RADIUS_M, well beyond enter).
//      The client asks the server for the wider read (the 60 m cap) so an edge agent
//      stays stably in the set; the client then trims that to the band itself.
//   2. Debounced exit. A rendered pin must be out-of-band for DROP_POLLS *consecutive*
//      polls before eviction, so a single bad fix (or one inconsistent server reply)
//      never evicts a stable agent.

// Enter when within this — matches the discovery gate (irl.js NEARBY_RADIUS). Metres.
export const ENTER_RADIUS_M = 40;
// Keep a rendered pin until it passes this. The 15 m band fully absorbs ±10 m GPS
// noise at the 40 m edge: a pin jittering 30–50 m never crosses the exit line, so it
// holds steady without a single dispose/respawn cycle.
export const EXIT_RADIUS_M = 55;
// Consecutive out-of-band polls before eviction. At irl.js POLL_INTERVAL_MS = 10 s
// this is ~10–20 s of *sustained* absence — long enough that edge jitter never trips
// it, short enough that a genuine walk-away or a server-side delete clears promptly.
export const DROP_POLLS = 2;

// Decide one pin's membership for this poll. Returns:
//   'spawn'  — not rendered, now within ENTER → render it (the discovery moment)
//   'ignore' — not rendered, still outside ENTER → do nothing (no drift-in discovery)
//   'keep'   — rendered and in-band (within EXIT and the server still lists it) → reset debounce
//   'wait'   — rendered but out-of-band, debounce not yet elapsed → hold + increment
//   'drop'   — rendered and out-of-band for DROP_POLLS consecutive polls → dispose
//
// `listed` is whether the server returned this pin this poll. A pin absent from the
// set (deleted, hidden, or walked far past the server cap) is treated as out-of-band
// regardless of its possibly-stale client distance — so an owner delete clears even
// from point-blank range, where distance alone would keep it rendered forever.
export function pinBandAction({ distance, rendered, listed, oobPolls = 0 }, opts = {}) {
	const enter = opts.enter ?? ENTER_RADIUS_M;
	const exit = opts.exit ?? EXIT_RADIUS_M;
	const dropPolls = opts.dropPolls ?? DROP_POLLS;

	if (!rendered) {
		return listed && distance <= enter ? 'spawn' : 'ignore';
	}
	const inBand = listed && distance <= exit;
	if (inBand) return 'keep';
	return oobPolls + 1 >= dropPolls ? 'drop' : 'wait';
}
