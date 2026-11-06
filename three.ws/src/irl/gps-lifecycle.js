// Pure helpers for the /irl GPS lifecycle and the local→GPS lock upgrade.
//
// Why this exists
// ───────────────
// Anchoring an agent to a real-world spot rides a consumer GPS watch and a
// transition between two camera regimes — a local gyro pivot (no fix yet) and the
// precise viewer-origin frame (a fix has landed). Two bits of that flow are pure
// number-crunching that must not drift or regress, so they live here behind unit
// tests instead of tangled into the live event/render code in src/irl.js:
//
//   1. Accuracy honesty — bucket a fix's horizontal accuracy (metres) so the UI can
//      tell the truth about how precise a placement really is, rather than implying
//      pinpoint accuracy on a ±40 m indoor fix.
//   2. Transition easing — the eased 0→1 parameter that glides the camera from the
//      gyro pivot to the viewer origin when the first fix upgrades a local lock, so
//      the avatar never visibly teleports relative to the room.
//
// No DOM, no Three.js, no clock — plain numbers in, plain numbers out.

// A fix at or under this horizontal accuracy (metres) is treated as a precise
// placement. Beyond it, consumer GPS is too noisy to claim an exact spot, so the
// UI says "approximate" and the stored gpsAccuracyM carries the honest number.
export const GPS_ACCURACY_PRECISE_M = 25;
// Past this, the fix is barely better than a neighbourhood guess (typical indoor /
// urban-canyon GPS) — surface it as coarse so the copy sets the right expectation.
export const GPS_ACCURACY_COARSE_M = 60;

// Bucket a horizontal-accuracy reading (metres) into a placement-quality level.
// Returns { level, precise, label, accuracyM } where:
//   level    — 'precise' | 'approximate' | 'coarse' | 'unknown'
//   precise  — true only for a genuinely tight fix (≤ GPS_ACCURACY_PRECISE_M)
//   label    — short human phrase for a subtle UI hint ('' when precise/unknown)
//   accuracyM — the rounded metres, or null when the device reported none
// A null/NaN reading is 'unknown' (the device couldn't measure it) — never claimed
// as precise, but not flagged as coarse either.
export function gpsAccuracyBucket(accuracyM) {
	if (!Number.isFinite(accuracyM) || accuracyM < 0) {
		return { level: 'unknown', precise: false, label: '', accuracyM: null };
	}
	const rounded = Math.round(accuracyM);
	if (accuracyM <= GPS_ACCURACY_PRECISE_M) {
		return { level: 'precise', precise: true, label: '', accuracyM: rounded };
	}
	if (accuracyM <= GPS_ACCURACY_COARSE_M) {
		return { level: 'approximate', precise: false, label: `±${rounded} m`, accuracyM: rounded };
	}
	return { level: 'coarse', precise: false, label: `±${rounded} m (low GPS accuracy)`, accuracyM: rounded };
}

// Duration of the local→GPS camera glide, milliseconds. Short enough to feel
// instantaneous, long enough to read as a settle rather than a snap.
export const GPS_TRANSITION_MS = 450;

// Eased 0→1 progress for the camera glide. Cubic ease-out: quick to start, gentle
// to land, so the viewpoint arrives at the viewer origin without an abrupt stop.
// Clamps out-of-range input so a long frame (t > 1) or a paused tab can't overshoot.
export function easeGpsTransition(t) {
	if (!Number.isFinite(t) || t <= 0) return 0;
	if (t >= 1) return 1;
	const inv = 1 - t;
	return 1 - inv * inv * inv;
}
