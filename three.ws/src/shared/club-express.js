// Express entry for /club — skip the alley walk-through AND the cover charge so
// you land straight on the pole stage, with the dance-tip buttons live.
//
// This exists for demos, screen recordings, and QA of the x402 dance-tip flow:
// the full production experience (walk the alley → pay $0.01 cover → get admitted
// → reach the poles) is a lot of friction to clear before you can show the part
// that matters — tipping a dancer in USDC and watching her take the pole.
//
// Enable with any of these query flags on /club:
//     /club?demo        /club?express        /club?skip-cover
//
// Only the *entrance gauntlet* is bypassed. The dance tip itself stays a real
// x402 payment — nothing is faked, no pass is forged, no data is mocked. A
// normal visit (no flag) is untouched: the alley and the cover door behave
// exactly as before.

const FLAGS = ['demo', 'express', 'skip-cover'];
const FALSEY = new Set(['0', 'false', 'no', 'off']);

let cached = null;

// True when the current URL opts into express entry. A flag counts as set when
// it's present and not explicitly disabled (`?demo=0` / `?demo=false` opt out),
// so `/club?demo` and `/club?demo=1` both enable it. Resolved once per load.
export function isExpressEntry() {
	if (cached !== null) return cached;
	cached = false;
	try {
		const q = new URLSearchParams(window.location.search);
		cached = FLAGS.some((f) => q.has(f) && !FALSEY.has((q.get(f) || '').toLowerCase()));
	} catch {
		cached = false;
	}
	return cached;
}
