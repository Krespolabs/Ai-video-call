// Deterministic world clock for the Ambient World DJ (Brief 22).
//
// The /agent-screen Ambient stage runs a living day/night cycle that EVERY viewer
// of the same agent must see identically — two people watching the same screen
// in different timezones should both agree it's dusk. So the time of day is a
// pure function of wall-clock time and a configurable cycle length, with no
// Math.random and no per-client state. Given the same `now` and `cycleMs` this
// returns the same phase on every machine.
//
// Phase is a day fraction in [0, 1): 0 = midnight, 0.25 = sunrise, 0.5 = noon,
// 0.75 = sunset — the exact convention src/game/day-night.js `setTime(t)` expects,
// so the value drops straight into the existing sun/sky rig.

// 8 real minutes per in-world day by default — long enough to feel calm, short
// enough that a viewer leaving the channel open sees the sun actually move.
export const DEFAULT_CYCLE_MS = 8 * 60 * 1000;

// Map wall-clock ms → day fraction [0,1). `offset` (ms) shifts an individual
// world's clock so two agents aren't locked to the same sky while each stays
// perfectly deterministic. Guards a non-positive cycle so a bad config can't
// divide by zero or NaN the sun.
export function worldClock(now, cycleMs = DEFAULT_CYCLE_MS, offset = 0) {
	const span = cycleMs > 0 ? cycleMs : DEFAULT_CYCLE_MS;
	const t = (Number(now) || 0) + (Number(offset) || 0);
	return (((t % span) + span) % span) / span;
}

// The four viewer-facing times of day, by phase band. Bands hug the sun arc:
// sunrise straddles 0.25, dusk straddles 0.75, the long day sits between, and
// everything past dusk before sunrise is night (the band wraps across 0/1).
export function phaseLabel(phase) {
	const p = (((Number(phase) || 0) % 1) + 1) % 1;
	if (p >= 0.22 && p < 0.30) return 'sunrise';
	if (p >= 0.30 && p < 0.70) return 'day';
	if (p >= 0.70 && p < 0.80) return 'dusk';
	return 'night';
}

// Golden hour — the warm window just before the sun touches the horizon. A
// narrower band than `dusk` so the DJ can call it out as its own moment.
export function isGoldenHour(phase) {
	const p = (((Number(phase) || 0) % 1) + 1) % 1;
	return p >= 0.66 && p < 0.74;
}

// 0 (deep night) … 1 (full day) — a smooth daylight amount from the sun's
// altitude, matching the smoothstep day-night.js uses to raise the lights. Lets
// callers cross-fade UI (the time-of-day readout, the ambient pad) with the sky
// instead of snapping at band edges.
export function daylightAmount(phase) {
	const p = (((Number(phase) || 0) % 1) + 1) % 1;
	const alt = Math.sin((p - 0.25) * Math.PI * 2); // -1 midnight … +1 noon
	const t = Math.max(0, Math.min(1, (alt + 0.10) / 0.28));
	return t * t * (3 - 2 * t);
}
