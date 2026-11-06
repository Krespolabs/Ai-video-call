// Proximity-arrival cue policy (IRL task 03) — pure, DOM-free, clock-free.
//
// We deleted the list and the radar on purpose: an agent's location is private
// and you discover one only by physically walking into its ~40 m bubble. The cost
// of that privacy is that a user can stand 15 m from an agent, facing the wrong
// way, and never know it's there. This module is the policy behind the cue that
// fixes that — the in-world equivalent of hearing a sound nearby: "something is
// here, turn around." It points a *direction*, never a list or a coordinate.
//
// Everything here is a pure function of numbers + flags, so the gating (one cue
// per arrival, a global cooldown so a busy spot isn't a slot machine) and the
// directional geometry (screen-relative bearing → an edge-clamped nudge that
// recomputes as the device rotates, and fades once the agent is on-screen) are
// proven in a unit test with no Three.js, no DOM, and no real clock. irl.js wires
// the WebAudio chime / haptic / aria-live banner / edge-glow DOM onto these
// decisions; the privacy-sensitive math (how far, which way) lives only here and
// is fed *world offsets the viewer already renders*, never raw pin coordinates.

// Minimum gap between two arrival cues, regardless of how many agents arrive. A
// plaza where ten agents drift into range at once must buzz the user once, then
// stay quiet — discovery should feel like a tap on the shoulder, not a slot
// machine. Tuned to the 10 s proximity poll: long enough that a burst collapses
// to a single cue, short enough that two genuinely separate walk-ups each land.
export const CUE_COOLDOWN_MS = 8000;

// Decide whether an arrival should fire its cue (haptic + chime + banner) now.
// Pure: the caller owns the clock and the "last cue" timestamp; we only compare.
//
//   now        — current time in ms (caller passes Date.now()).
//   lastCueAt  — when the last cue fired, or null/undefined if none yet.
//   cooldownMs — override the global cooldown (defaults to CUE_COOLDOWN_MS).
//
// Returns true when no cue has fired yet, or the cooldown has fully elapsed. The
// arrival *signal* itself is already debounced upstream (proximity-band.js only
// emits on a genuine, hysteresis-stable enter), so this layer is purely the
// "don't carpet-bomb a busy corner" rate limit — never the de-dupe of a single
// jittering agent.
export function shouldCueArrival(now, lastCueAt, cooldownMs = CUE_COOLDOWN_MS) {
	if (!Number.isFinite(now)) return false;
	if (lastCueAt == null || !Number.isFinite(lastCueAt)) return true;
	return now - lastCueAt >= cooldownMs;
}

// Normalise any angle (radians) to (-π, π]. Used so a bearing difference reads as
// the *shortest* turn — +0.1 rad is "barely right", not "almost all the way around".
export function normalizeAngle(rad) {
	let a = rad % (Math.PI * 2);
	if (a > Math.PI) a -= Math.PI * 2;
	if (a <= -Math.PI) a += Math.PI * 2;
	return a;
}

// Screen-relative bearing (radians) to a world offset, given where the viewer is
// looking. This is the heart of the directional nudge and the ONLY place a pin's
// position turns into a "which way to turn" — and even here it consumes the world
// offset {x, z} the viewer already renders (metres relative to the camera, from
// pinWorldPos), never a latitude/longitude, so nothing leaks that the on-screen
// scene wasn't already showing.
//
//   x, z      — the agent's world offset from the viewer in metres. In the IRL
//               frame +x is screen-right and -z is forward (the camera looks down
//               -z), so the agent's absolute bearing is atan2(x, -z) (0 = ahead,
//               +π/2 = hard right, ±π = directly behind).
//   cameraYaw — the viewer's facing in radians (0 = looking along -z = "north" of
//               the local frame), matching irl.js cameraYaw.
//
// Returns the bearing *relative to where the camera points*: 0 = the agent is dead
// ahead of the current view, + = the user must turn right to face it, - = left,
// ±π = it's directly behind them. Recompute every frame as cameraYaw changes and
// the nudge tracks the agent live as the user rotates.
export function relativeBearing(x, z, cameraYaw) {
	const absolute = Math.atan2(x, -z);
	return normalizeAngle(absolute - cameraYaw);
}

// Is the agent comfortably within the view cone (so the visible avatar itself is
// the cue and the edge nudge should fade)? `relBearing` is the output of
// relativeBearing above; `halfFovRad` is half the camera's *horizontal* field of
// view. We require the agent to be inside ~85% of the half-FOV before we call it
// "on screen" — a small inset hysteresis so a pin hovering exactly on the frame
// edge doesn't flicker the nudge on and off as the user's hand shakes.
export function isFacingAgent(relBearing, halfFovRad) {
	if (!Number.isFinite(relBearing) || !Number.isFinite(halfFovRad)) return false;
	return Math.abs(relBearing) <= halfFovRad * 0.85;
}

// Place the edge nudge. Given the relative bearing and the viewport, return where
// to pin the arrow on the screen border and how to rotate it so it points toward
// the off-screen agent. We DON'T project the 3D point (it may be behind the camera,
// where projection flips); instead we map the bearing directly onto an ellipse
// inscribed in the safe-inset viewport, which is stable for the full ±π range and
// gives the "compass needle riding the screen edge" feel.
//
//   relBearing — radians from relativeBearing(): 0 ahead, + right, - left, ±π behind.
//   width      — viewport width in CSS px.
//   height     — viewport height in CSS px.
//   inset      — px to keep the glow off the very edge (default 34) so it clears
//                rounded corners / notches and reads as a deliberate UI element.
//
// Returns { x, y } (CSS px, where to centre the glow) and `rotateDeg` (the arrow's
// rotation in degrees, 0 = pointing straight up, increasing clockwise) so the head
// of the arrow aims along the bearing toward the agent.
export function edgeNudgePlacement(relBearing, width, height, inset = 34) {
	const b = normalizeAngle(relBearing);
	const cx = width / 2;
	const cy = height / 2;
	const rx = Math.max(8, cx - inset);
	const ry = Math.max(8, cy - inset);

	// Map the bearing onto the viewport ellipse. Screen +x is right (sin b) and the
	// agent being *ahead* (b = 0) should ride the TOP edge, so screen-up is -cos b.
	const dirX = Math.sin(b);
	const dirY = -Math.cos(b);
	const x = cx + dirX * rx;
	const y = cy + dirY * ry;

	// Arrow points along the bearing. atan2(dirX, -dirY) gives 0° = up, +90° = right,
	// matching a CSS rotate() of a glyph drawn pointing up.
	const rotateDeg = (Math.atan2(dirX, -dirY) * 180) / Math.PI;
	return { x, y, rotateDeg };
}

// Pick the single agent the nudge should point at. Per the spec we nudge toward the
// NEAREST in-range agent only — one clear "that way", never a confusing cluster of
// arrows. `agents` is an array of objects each carrying a numeric `distance` (the
// band distance from the viewer); returns the closest, or null for an empty set.
export function nearestAgent(agents) {
	let best = null;
	let bestDist = Infinity;
	for (const a of agents) {
		const d = a?.distance;
		if (!Number.isFinite(d)) continue;
		if (d < bestDist) { bestDist = d; best = a; }
	}
	return best;
}
