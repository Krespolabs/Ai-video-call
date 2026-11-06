// Ambient World DJ — turns world state into a calm spoken host script (Brief 22).
//
// On the /agent-screen Ambient stage the agent stops trading and starts hosting:
// it watches the living world (the day/night phase, how busy the plaza is, the
// odd wanderer) and narrates it in short, calm lines — the "lo-fi beats" of the
// agent wall. This module is the script generator. It is pure logic (no Three.js,
// no DOM, no network) so it unit-tests cleanly and the stage just feeds it world
// snapshots and plays back whatever it returns.
//
// Two rules keep it calm instead of chatty:
//   1. A minimum gap between lines (default ~28s) — observe() returns null until
//      the gap has elapsed, no matter how much the world changed.
//   2. Lines are templated from real world events (a sunrise, golden hour, the
//      plaza filling up), never random filler. Each event has a small rotation
//      of phrasings advanced by a counter — varied, but deterministic, so there's
//      no Math.random in the path.

import { phaseLabel, isGoldenHour } from './shared/world-clock.js';

// Default minimum spacing between spoken host lines. Calm pacing: one line every
// ~28s settles to roughly two a minute even when the world is eventful.
export const DJ_MIN_GAP_MS = 28_000;

// Event → mood tag the stage uses to tint the log entry and (with audio on) pick
// the TTS delivery. Kept small and human.
const EVENT_MOOD = {
	sunrise: 'warm',
	goldenHour: 'warm',
	dusk: 'calm',
	night: 'sleepy',
	zoneBusy: 'lively',
	npcArrived: 'lively',
	idleAmbiance: 'calm',
};

// Phrasings per event. `{place}` is the agent's world (a biome label) and
// `{landmark}` the spot the camera frames. Calm, coin-agnostic, never a market
// call — the Ambient channel is the opposite of the trading desk.
const LINES = {
	sunrise: [
		'Sun’s coming up over {place}. Soft light on {landmark}.',
		'Dawn breaks across {place} — the world stretches awake.',
		'First light. {landmark} warms up gold and quiet.',
	],
	goldenHour: [
		'Golden hour over {place}. Everything’s lit like honey right now.',
		'The light’s gone warm and long across {landmark}. Best part of the day.',
		'Sun’s low and golden. {place} glows for a few minutes more.',
	],
	dusk: [
		'Sun’s setting over {landmark}. Quiet shift tonight.',
		'Dusk settling on {place}. The sky cools toward dark.',
		'Last of the light fading over {landmark}. Lamps coming on.',
	],
	night: [
		'Night over {place}. Just the stars and a little wind now.',
		'It’s gone dark and still across {landmark}. Calm out here.',
		'Stars are out over {place}. The quiet shift begins.',
	],
	zoneBusy: [
		'Bit of a crowd gathering near {landmark} — nice to see some life.',
		'{landmark}’s filling up. The world’s busy this hour.',
		'Foot traffic picking up around {place}. Good energy.',
	],
	npcArrived: [
		'Someone just wandered up to {landmark}. We’ve got company.',
		'New face drifting through {place}. Welcome in.',
		'A wanderer reaches {landmark} and stops to look around.',
	],
	idleAmbiance: [
		'Quiet out here right now — just the wind through {place}.',
		'Nothing urgent on {landmark}. Leave it on, let it breathe.',
		'Calm shift over {place}. The world ticks along on its own.',
	],
};

function fill(template, ctx) {
	return template
		.replace(/\{place\}/g, ctx.place)
		.replace(/\{landmark\}/g, ctx.landmark);
}

/**
 * Build a DJ script for one agent's ambient stage.
 *
 * @param {object} [opts]
 * @param {number} [opts.minGapMs]   minimum ms between emitted lines
 * @param {string} [opts.place]      the world's name (biome label) for templating
 * @param {string} [opts.landmark]   the framed spot (e.g. "the plaza", "the wall")
 * @returns {{ observe: (state:object, now:number) => (null | {text:string,type:string,mood:string,event:string}), reset: () => void }}
 */
export function createDjScript({ minGapMs = DJ_MIN_GAP_MS, place = 'the world', landmark = 'the plaza' } = {}) {
	const ctx = { place, landmark };
	const rot = Object.create(null); // event → next phrasing index (deterministic rotation)
	let lastEmitAt = -Infinity;
	let lastLabel = null;
	let lastGolden = false;
	let lastBusy = false;
	let lastPedCount = null;

	// Pick the highest-priority event the world is currently presenting that we
	// haven't already announced. Transitions (a band the sky just crossed) outrank
	// the steady-state crowd reading, which outranks plain idle ambiance.
	function pickEvent(state) {
		const label = phaseLabel(state.phase);
		const golden = isGoldenHour(state.phase);

		// Golden hour is its own beat, called once as it begins.
		if (golden && !lastGolden) return 'goldenHour';
		// A fresh time-of-day band (sunrise/dusk/night/day → we narrate the named ones).
		if (label !== lastLabel && (label === 'sunrise' || label === 'dusk' || label === 'night')) return label;

		// A wanderer arriving — a rising edge in the detailed crowd count.
		if (lastPedCount != null && (state.pedCount | 0) > lastPedCount) return 'npcArrived';

		// The plaza filling up — a rising edge across the "busy" threshold.
		const busy = (Number(state.crowd) || 0) >= 0.6;
		if (busy && !lastBusy) return 'zoneBusy';

		// Nothing new — keep the channel alive with calm ambiance.
		return 'idleAmbiance';
	}

	return {
		observe(state, now) {
			if (!state) return null;
			if (now - lastEmitAt < minGapMs) return null;

			const event = pickEvent(state);

			// Update memory AFTER picking so a rising edge is detected exactly once.
			lastLabel = phaseLabel(state.phase);
			lastGolden = isGoldenHour(state.phase);
			lastBusy = (Number(state.crowd) || 0) >= 0.6;
			lastPedCount = state.pedCount | 0;

			const bank = LINES[event] || LINES.idleAmbiance;
			const i = (rot[event] || 0) % bank.length;
			rot[event] = i + 1;
			lastEmitAt = now;

			return {
				text: fill(bank[i], ctx),
				type: 'activity',
				mood: EVENT_MOOD[event] || 'calm',
				event,
			};
		},
		reset() {
			lastEmitAt = -Infinity;
			lastLabel = null;
			lastGolden = false;
			lastBusy = false;
			lastPedCount = null;
		},
	};
}
