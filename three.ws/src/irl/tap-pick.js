// IRL tap picking — pure, DOM-free, Three.js-free screen-space ranking (task 05).
//
// On a phone the body mesh of a distant or small agent is a poor tap target, so
// irl.js casts a ray at the agent meshes first (front body wins a depth tie for
// free) and, only when that misses, falls back to a finger-sized "label net":
// the nearest on-screen name label within a touch radius of the tap point. That
// fallback is the floor for tap reliability — and it is the part worth proving in
// isolation, because the ranking has two subtle rules a manual device test can't
// pin down repeatably:
//
//   1. A clear pixel winner (closer to the finger by more than the tie band) takes
//      the tap — fat-finger tolerance, so a tap *near* a label still selects it.
//   2. Among labels the finger lands on within the tie band (a cluster), the agent
//      physically NEAREST the viewer wins, so overlapping labels resolve to the one
//      in front rather than whichever happened to iterate last.
//
// The function consumes plain candidates ({ sx, sy, distance, ... }) the caller
// already cached during label layout — no projection, no DOM, no allocation beyond
// the candidate list — so it unit-tests with bare numbers and is reused verbatim by
// irl.js's tap handler.

// Touch radius around a label centre, in CSS px. Wider than the visible label box
// so a tap that lands just outside the pill still selects it — sized for a finger,
// not a cursor.
export const TAP_SLOP_PX = 28;

// Two labels whose distance-to-finger differ by less than this (px) are treated as
// a tie, and broken by viewer proximity instead of by sub-pixel finger position.
// Keeps clustered labels from flickering their selection under a shaky tap.
export const TIE_BAND_PX = 8;

function viewerDistance(c) {
	const d = c?.distance;
	return Number.isFinite(d) ? d : Infinity;
}

// Pick the label the tap selects, or null if the finger landed outside every
// label's slop radius. `candidates` is an array of objects each with screen-space
// centre `sx`/`sy` (CSS px) and a viewer `distance` (metres; non-finite = treat as
// farthest). Candidates with a non-finite centre are skipped (their label wasn't
// laid out this frame). The original candidate object is returned so the caller can
// read whatever it hung off it (e.g. the pin) without a second lookup.
export function pickLabelHit(candidates, px, py, opts = {}) {
	const slop = opts.slop ?? TAP_SLOP_PX;
	const tie  = opts.tie  ?? TIE_BAND_PX;
	if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

	let best = null;
	let bestPx = Infinity;
	for (const c of candidates) {
		if (!c || c.onScreen === false) continue;
		if (!Number.isFinite(c.sx) || !Number.isFinite(c.sy)) continue;
		const d = Math.hypot(px - c.sx, py - c.sy);
		if (d > slop) continue;
		if (d < bestPx - tie) {
			best = c; bestPx = d;
		} else if (Math.abs(d - bestPx) <= tie && viewerDistance(c) < viewerDistance(best)) {
			// Cluster tie: the agent nearer the viewer (in front) wins.
			best = c; bestPx = d;
		}
	}
	return best;
}
