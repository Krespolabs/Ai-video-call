// The dance styles the /club stage sells, shared by the paid endpoint
// (api/x402/dance-tip.js) and the free tip feeds (api/club/tips*.js), which
// attach each row's choreography so a spectator replays the routine the payer
// bought. src/club-dances.js mirrors the menu order and labels for the browser;
// tests/club-dances.test.js keeps the two in step.

// `track` names map to /public/club/audio/<track>.{ogg,mp3} loops the /club
// page crossfades to when the dance starts. The client picks whichever format
// the browser supports: see src/club-audio.js loadBuffer().
export const STYLES = Object.freeze({
	// Free-floor (existing): single clip looped for the full duration.
	hiphop:   { clip: 'dance',    label: 'Hip Hop',  loop: true, durationSec: 12, track: 'hiphop' },
	rumba:    { clip: 'rumba',    label: 'Rumba',    loop: true, durationSec: 14, track: 'rumba' },
	silly:    { clip: 'silly',    label: 'Silly',    loop: true, durationSec: 10, track: 'silly' },
	thriller: { clip: 'thriller', label: 'Thriller', loop: true, durationSec: 14, track: 'thriller' },
	capoeira: { clip: 'capoeira', label: 'Capoeira', loop: true, durationSec: 12, track: 'capoeira' },
	// 16.1s of choreography, the longest single-clip style on the stage: booked
	// for one full pass rather than cut mid-routine.
	offabean: { clip: 'av-offabean-dance', label: 'Offabean', loop: true, durationSec: 16, track: 'hiphop' },

	// Pole work: `pole: true` tells the /club stage to turn the dancer into the
	// pole and dance against it (back to the crowd) rather than facing out like
	// the free-floor styles. The twerk loops on the pole for the full duration.
	twerk: {
		clip: 'twerk', label: 'Pole Twerk', loop: true, durationSec: 12,
		track: 'im-in-love-wit-a-stripper-fast', pole: true,
	},

	// Choreographed routines: sequences chain multiple clips back-to-back at
	// PoleStation playback time (the feature free-floor styles lack). Every clip
	// here is a real, deployed entry in /animations/manifest.json so the routine
	// always performs; durationSec is the sum of the steps. The audio loop
	// crossfades to the dedicated `pole` track (/public/club/audio/pole.*).
	spin: {
		label: 'Spin',
		durationSec: 10,
		track: 'pole',
		sequence: [
			{ clip: 'capoeira', durationSec: 6 },
			{ clip: 'dance',    durationSec: 4 },
		],
	},
	climb: {
		label: 'Slow Burn',
		durationSec: 14,
		track: 'pole',
		sequence: [
			{ clip: 'thriller', durationSec: 7 },
			{ clip: 'capoeira', durationSec: 4 },
			{ clip: 'dance',    durationSec: 3 },
		],
	},
	combo: {
		label: 'Full Combo',
		durationSec: 18,
		track: 'pole',
		sequence: [
			{ clip: 'rumba',    durationSec: 4 },
			{ clip: 'capoeira', durationSec: 4 },
			{ clip: 'thriller', durationSec: 4 },
			{ clip: 'silly',    durationSec: 3 },
			{ clip: 'dance',    durationSec: 3 },
		],
	},
});

/**
 * The choreography a spectator needs to replay a tip row: the style's booked
 * duration, audio loop, pole flag and clip sequence. Null for a style this
 * build no longer sells (an old row), so the caller keeps the row's own clip.
 * @param {string} key
 */
export function styleChoreography(key) {
	const style = Object.hasOwn(STYLES, key) ? STYLES[key] : null;
	if (!style) return null;
	const out = { durationSec: style.durationSec, track: style.track };
	if (style.pole) out.pole = true;
	if (style.sequence) out.sequence = style.sequence;
	return out;
}
