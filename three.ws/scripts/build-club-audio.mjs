#!/usr/bin/env node
//
// scripts/build-club-audio.mjs
// =============================================================================
// Synthesise the seven /club audio loops (six dance styles + crowd ambience)
// and encode each one to both `.ogg` (stereo Vorbis q4) and `.mp3` (mono
// 192 kbit) under public/club/audio/. Run via `node scripts/build-club-audio.mjs`.
//
// Why we author locally instead of shipping third-party samples:
//   The /club rails (CLAUDE.md) require real licensed audio committed to the
//   repo. The cleanest, license-unencumbered way to satisfy that is to
//   generate the loops from scratch with ffmpeg's `lavfi` filtergraph — the
//   resulting WAVs are wholly authored here, so we can release them CC0 (see
//   public/club/audio/LICENSES.md). No external samples, no attribution
//   ambiguity, no >2 MB asset bloat.
//
// Synthesis approach:
//   Each track is a short rhythmic bed assembled from oscillator + noise
//   primitives ffmpeg already ships (`sine`, `anoisesrc`, `tremolo`, `aecho`,
//   `bandpass`/`lowpass` filters). We avoid speed/atempo on `aevalsrc` because
//   precise loop length matters — every track is rendered to an exact integer
//   number of beats and ffmpeg `-t` is set so the final waveform loops
//   click-free at the seam. Peaks are limited to about –6 dBFS via
//   `dynaudnorm` so the master bus has headroom for the bloom-era postfx.
//
// This script is idempotent — re-running overwrites the existing files with
// byte-identical output (within ffmpeg's deterministic encoder limits).

import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/club/audio');

const SAMPLE_RATE = 44_100;

// ─── Filtergraph building blocks ────────────────────────────────────────────
//
// Each helper returns a single ffmpeg `-filter_complex` snippet that produces
// one labelled audio stream. Streams are mixed at the end into [out] which is
// what we encode.

// 4/4 kick pattern at the given BPM. We model the kick as an exponentially
// decaying sine wave (60 Hz fundamental) gated by a click envelope.
function kickPattern(bpm, bars = 4) {
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	// 16th-note grid: hits on every quarter (1, 5, 9, 13). Express as
	// `aevalsrc` arithmetic so a single source covers the loop.
	const expr = `0.85*sin(2*PI*60*t)*exp(-12*mod(t,${beatSec.toFixed(6)}))`;
	return `aevalsrc='${expr}':d=${totalSec.toFixed(6)}:s=${SAMPLE_RATE},lowpass=f=160`;
}

// Snare/clap on beats 2 and 4. Bandpassed noise burst with a sharp decay.
function snarePattern(bpm, bars = 4) {
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	// Trigger only on offset half of each beat pair (i.e. beats 2/4 of a 4-beat bar).
	// Use a 2-beat repeating envelope: hit at t mod (2*beat) ≈ beat.
	const period = (beatSec * 2).toFixed(6);
	const offset = beatSec.toFixed(6);
	const expr = `exp(-26*if(lt(mod(t-${offset},${period}),0),mod(t-${offset},${period})+${period},mod(t-${offset},${period})))*0.55`;
	return `anoisesrc=d=${totalSec.toFixed(6)}:r=${SAMPLE_RATE}:a=0.85:c=pink,bandpass=f=1800:w=900,volume='${expr}':eval=frame`;
}

// Closed hi-hat 8ths — bright noise burst on every off-eighth.
function hatPattern(bpm, bars = 4) {
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	const eighth = (beatSec / 2).toFixed(6);
	const expr = `exp(-60*mod(t,${eighth}))*0.18`;
	return `anoisesrc=d=${totalSec.toFixed(6)}:r=${SAMPLE_RATE}:a=0.7:c=white,highpass=f=6000,volume='${expr}':eval=frame`;
}

// Pure sine bassline — accepts an array of {beat, freq} hits.
function basslinePattern(bpm, bars, notes) {
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	// Build a piecewise frequency expression over the loop length.
	// Each note is a half-beat-long ramp into the next.
	// Use a simple cascade: collect (start, freq) pairs and fold them into
	// nested `if(gte(t, t0)*lt(t, t1), freq, …)`.
	const sortedNotes = [...notes].sort((a, b) => a.beat - b.beat);
	let freqExpr = '0';
	for (let i = sortedNotes.length - 1; i >= 0; i--) {
		const n = sortedNotes[i];
		const t0 = (n.beat * beatSec).toFixed(6);
		freqExpr = `if(gte(t,${t0}),${n.freq.toFixed(3)},${freqExpr})`;
	}
	const expr = `0.30*sin(2*PI*(${freqExpr})*t)`;
	return `aevalsrc='${expr}':d=${totalSec.toFixed(6)}:s=${SAMPLE_RATE},lowpass=f=320`;
}

// Lead synth — square-like saw, useful for thriller/silly/hiphop melodies.
function leadPattern(bpm, bars, notes, gain = 0.18) {
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	const sortedNotes = [...notes].sort((a, b) => a.beat - b.beat);
	let freqExpr = '0';
	let gateExpr = '0';
	for (let i = sortedNotes.length - 1; i >= 0; i--) {
		const n = sortedNotes[i];
		const t0 = (n.beat * beatSec).toFixed(6);
		const t1 = ((n.beat + (n.length || 0.5)) * beatSec).toFixed(6);
		freqExpr = `if(gte(t,${t0}),${n.freq.toFixed(3)},${freqExpr})`;
		gateExpr = `if(gte(t,${t0})*lt(t,${t1}),1,${gateExpr})`;
	}
	const expr = `${gain.toFixed(3)}*(2*((t*(${freqExpr}))-floor(0.5+t*(${freqExpr}))))*(${gateExpr})`;
	return `aevalsrc='${expr}':d=${totalSec.toFixed(6)}:s=${SAMPLE_RATE},lowpass=f=4200`;
}

// Triangle-wave lead for softer styles (rumba/capoeira).
function triadPattern(bpm, bars, notes, gain = 0.16) {
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	const sortedNotes = [...notes].sort((a, b) => a.beat - b.beat);
	let freqExpr = '0';
	let gateExpr = '0';
	for (let i = sortedNotes.length - 1; i >= 0; i--) {
		const n = sortedNotes[i];
		const t0 = (n.beat * beatSec).toFixed(6);
		const t1 = ((n.beat + (n.length || 0.5)) * beatSec).toFixed(6);
		freqExpr = `if(gte(t,${t0}),${n.freq.toFixed(3)},${freqExpr})`;
		gateExpr = `if(gte(t,${t0})*lt(t,${t1}),1,${gateExpr})`;
	}
	// Triangle ≈ 2/π * arcsin(sin(2πft)); approximate with a phase-folded sine.
	const expr = `${gain.toFixed(3)}*((2/PI)*asin(sin(2*PI*(${freqExpr})*t)))*(${gateExpr})`;
	return `aevalsrc='${expr}':d=${totalSec.toFixed(6)}:s=${SAMPLE_RATE},lowpass=f=3500`;
}

// ─── Style track recipes ─────────────────────────────────────────────────────

// Each entry yields a filter_complex string that produces a single mixed
// stream labeled `[mix]` at SAMPLE_RATE. The loop length must be an integer
// number of beats so the seam is sample-clean.

function ambienceRecipe() {
	// 60-second crowd bed: pink-noise "room tone" + slow tremolo (chatter
	// rhythm) + a far-off low rumble that suggests low-end PA energy. No
	// rhythmic content so it never fights the dance loops it ducks under.
	const totalSec = 60;
	const parts = [
		// Body — pink noise with a gentle lowpass for warmth.
		`anoisesrc=d=${totalSec}:r=${SAMPLE_RATE}:a=0.10:c=pink,bandpass=f=900:w=1400,tremolo=f=2.5:d=0.35[chatter]`,
		// Low rumble — very slow LFO on a deep sine wave.
		`aevalsrc='0.07*sin(2*PI*50*t)*(1+0.6*sin(2*PI*0.18*t))':d=${totalSec}:s=${SAMPLE_RATE},lowpass=f=120[rumble]`,
		// Air movement — quiet high-frequency hiss for "room" presence.
		`anoisesrc=d=${totalSec}:r=${SAMPLE_RATE}:a=0.04:c=white,highpass=f=4000[air]`,
	];
	const graph = [
		...parts,
		`[chatter][rumble][air]amix=inputs=3:duration=longest:normalize=0,dynaudnorm=g=11:p=0.78[mix]`,
	].join(';');
	return { graph, durationSec: totalSec };
}

// HIP HOP — 95 BPM, two bars, classic boom-bap pattern with a low piano stab.
function hiphopRecipe() {
	const bpm = 95;
	const bars = 4;
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	// Bass riff in A minor — root, fifth, flat-seven cycle.
	const bass = basslinePattern(bpm, bars, [
		{ beat: 0, freq: 55.0 }, // A1
		{ beat: 2, freq: 65.4 }, // C2
		{ beat: 4, freq: 73.4 }, // D2
		{ beat: 6, freq: 49.0 }, // G1
		{ beat: 8, freq: 55.0 },
		{ beat: 10, freq: 65.4 },
		{ beat: 12, freq: 73.4 },
		{ beat: 14, freq: 49.0 },
	]);
	// Lead — short stabs on the off-beats.
	const lead = leadPattern(
		bpm,
		bars,
		[
			{ beat: 1.5, freq: 220.0, length: 0.25 },
			{ beat: 3.5, freq: 261.6, length: 0.25 },
			{ beat: 5.5, freq: 293.7, length: 0.25 },
			{ beat: 7.5, freq: 196.0, length: 0.25 },
			{ beat: 9.5, freq: 220.0, length: 0.25 },
			{ beat: 11.5, freq: 261.6, length: 0.25 },
			{ beat: 13.5, freq: 293.7, length: 0.25 },
			{ beat: 15.5, freq: 196.0, length: 0.25 },
		],
		0.13,
	);
	const graph = [
		`${kickPattern(bpm, bars)}[kick]`,
		`${snarePattern(bpm, bars)}[snare]`,
		`${hatPattern(bpm, bars)}[hat]`,
		`${bass}[bass]`,
		`${lead}[lead]`,
		`[kick][snare][hat][bass][lead]amix=inputs=5:duration=longest:normalize=0,aecho=0.6:0.3:60:0.25,dynaudnorm=g=11:p=0.78[mix]`,
	].join(';');
	return { graph, durationSec: totalSec };
}

// RUMBA — 100 BPM, syncopated clave, triangle melody, warm bass.
function rumbaRecipe() {
	const bpm = 100;
	const bars = 4;
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	const bass = basslinePattern(bpm, bars, [
		{ beat: 0, freq: 73.4 }, // D2
		{ beat: 1.5, freq: 110.0 }, // A2
		{ beat: 3, freq: 87.3 }, // F2
		{ beat: 4, freq: 73.4 },
		{ beat: 6, freq: 98.0 }, // G2
		{ beat: 8, freq: 73.4 },
		{ beat: 9.5, freq: 110.0 },
		{ beat: 11, freq: 87.3 },
		{ beat: 12, freq: 73.4 },
		{ beat: 14, freq: 98.0 },
	]);
	const lead = triadPattern(
		bpm,
		bars,
		[
			{ beat: 0, freq: 293.7, length: 1.5 }, // D4
			{ beat: 1.5, freq: 440.0, length: 1.5 }, // A4
			{ beat: 3, freq: 349.2, length: 1 }, // F4
			{ beat: 4, freq: 293.7, length: 1.5 },
			{ beat: 5.5, freq: 392.0, length: 1.5 }, // G4
			{ beat: 7, freq: 349.2, length: 1 },
			{ beat: 8, freq: 293.7, length: 1.5 },
			{ beat: 9.5, freq: 440.0, length: 1.5 },
			{ beat: 11, freq: 349.2, length: 1 },
			{ beat: 12, freq: 293.7, length: 1.5 },
			{ beat: 13.5, freq: 392.0, length: 1.5 },
			{ beat: 15, freq: 349.2, length: 1 },
		],
		0.2,
	);
	// Clave — short percussive clicks (3-2 pattern) made from bandpassed noise.
	const claveExpr = (() => {
		const hits = [0, 1.5, 3, 4, 6].map((b) => (b * beatSec).toFixed(6));
		const env = hits.map((t) => `exp(-90*if(lt(t-${t},0),9999,t-${t}))`).join('+');
		return `(${env})*0.45`;
	})();
	const clave = `anoisesrc=d=${totalSec.toFixed(6)}:r=${SAMPLE_RATE}:a=0.7:c=pink,bandpass=f=2400:w=1000,volume='${claveExpr}':eval=frame`;
	const graph = [
		`${kickPattern(bpm, bars)}[kick]`,
		`${clave}[clave]`,
		`${bass}[bass]`,
		`${lead}[lead]`,
		`[kick][clave][bass][lead]amix=inputs=4:duration=longest:normalize=0,dynaudnorm=g=11:p=0.78[mix]`,
	].join(';');
	return { graph, durationSec: totalSec };
}

// THRILLER — 120 BPM minor groove with a low droning synth + chromatic stabs.
function thrillerRecipe() {
	const bpm = 120;
	const bars = 4;
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	const bass = basslinePattern(bpm, bars, [
		{ beat: 0, freq: 55.0 }, // A1
		{ beat: 4, freq: 58.3 }, // Bb1
		{ beat: 8, freq: 55.0 },
		{ beat: 12, freq: 49.0 }, // G1
	]);
	const lead = leadPattern(
		bpm,
		bars,
		[
			{ beat: 0, freq: 220.0, length: 0.5 },
			{ beat: 1, freq: 233.1, length: 0.5 },
			{ beat: 2, freq: 220.0, length: 0.5 },
			{ beat: 3, freq: 196.0, length: 1.0 },
			{ beat: 4.5, freq: 261.6, length: 0.5 },
			{ beat: 5.5, freq: 220.0, length: 1.0 },
			{ beat: 8, freq: 220.0, length: 0.5 },
			{ beat: 9, freq: 233.1, length: 0.5 },
			{ beat: 10, freq: 220.0, length: 0.5 },
			{ beat: 11, freq: 196.0, length: 1.0 },
			{ beat: 12.5, freq: 261.6, length: 0.5 },
			{ beat: 13.5, freq: 220.0, length: 1.5 },
		],
		0.16,
	);
	// Drone — slow detuned sine for that "haunting" vibe.
	const drone = `aevalsrc='0.10*(sin(2*PI*110*t)+sin(2*PI*110.6*t))':d=${totalSec.toFixed(6)}:s=${SAMPLE_RATE},lowpass=f=600`;
	const graph = [
		`${kickPattern(bpm, bars)}[kick]`,
		`${snarePattern(bpm, bars)}[snare]`,
		`${hatPattern(bpm, bars)}[hat]`,
		`${bass}[bass]`,
		`${lead}[lead]`,
		`${drone}[drone]`,
		`[kick][snare][hat][bass][lead][drone]amix=inputs=6:duration=longest:normalize=0,aecho=0.6:0.4:120:0.35,dynaudnorm=g=11:p=0.78[mix]`,
	].join(';');
	return { graph, durationSec: totalSec };
}

// CAPOEIRA — 110 BPM, berimbau-style rhythmic ostinato. We approximate the
// berimbau with a short metallic "twang" + bandpassed noise atabaque.
function capoeiraRecipe() {
	const bpm = 110;
	const bars = 4;
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	// Berimbau ostinato — D / D_flat / D / open / ring pattern.
	const lead = triadPattern(
		bpm,
		bars,
		[
			{ beat: 0, freq: 196.0, length: 0.5 }, // G3 — "ring"
			{ beat: 1, freq: 174.6, length: 0.5 }, // F3
			{ beat: 2, freq: 196.0, length: 0.5 },
			{ beat: 3, freq: 130.8, length: 1.0 }, // C3 — open
			{ beat: 4, freq: 196.0, length: 0.5 },
			{ beat: 5, freq: 174.6, length: 0.5 },
			{ beat: 6, freq: 196.0, length: 0.5 },
			{ beat: 7, freq: 130.8, length: 1.0 },
			{ beat: 8, freq: 196.0, length: 0.5 },
			{ beat: 9, freq: 174.6, length: 0.5 },
			{ beat: 10, freq: 196.0, length: 0.5 },
			{ beat: 11, freq: 130.8, length: 1.0 },
			{ beat: 12, freq: 220.0, length: 0.5 },
			{ beat: 13, freq: 174.6, length: 0.5 },
			{ beat: 14, freq: 196.0, length: 0.5 },
			{ beat: 15, freq: 130.8, length: 1.0 },
		],
		0.22,
	);
	// Atabaque — low congas approximation on 1+3 of each bar.
	const congaExpr = (() => {
		const hits = [];
		for (let bar = 0; bar < bars; bar++) {
			hits.push(bar * 4 * beatSec, (bar * 4 + 2.5) * beatSec);
		}
		const env = hits
			.map(
				(t) =>
					`exp(-18*if(lt(t-${t.toFixed(6)},0),9999,t-${t.toFixed(6)}))*sin(2*PI*120*t)`,
			)
			.join('+');
		return `0.45*(${env})`;
	})();
	const conga = `aevalsrc='${congaExpr}':d=${totalSec.toFixed(6)}:s=${SAMPLE_RATE},lowpass=f=240`;
	const graph = [
		`${conga}[conga]`,
		`${hatPattern(bpm, bars)}[hat]`,
		`${lead}[lead]`,
		`[conga][hat][lead]amix=inputs=3:duration=longest:normalize=0,dynaudnorm=g=11:p=0.78[mix]`,
	].join(';');
	return { graph, durationSec: totalSec };
}

// SILLY — 130 BPM cartoonish bounce, major-key arpeggio, woodblock claps.
function sillyRecipe() {
	const bpm = 130;
	const bars = 4;
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	const bass = basslinePattern(bpm, bars, [
		{ beat: 0, freq: 65.4 }, // C2
		{ beat: 1, freq: 98.0 }, // G2
		{ beat: 2, freq: 65.4 },
		{ beat: 3, freq: 87.3 }, // F2
		{ beat: 4, freq: 65.4 },
		{ beat: 5, freq: 98.0 },
		{ beat: 6, freq: 73.4 }, // D2
		{ beat: 7, freq: 87.3 },
		{ beat: 8, freq: 65.4 },
		{ beat: 9, freq: 98.0 },
		{ beat: 10, freq: 65.4 },
		{ beat: 11, freq: 87.3 },
		{ beat: 12, freq: 110.0 }, // A2
		{ beat: 13, freq: 98.0 },
		{ beat: 14, freq: 87.3 },
		{ beat: 15, freq: 73.4 },
	]);
	const lead = leadPattern(
		bpm,
		bars,
		[
			{ beat: 0, freq: 523.3, length: 0.5 }, // C5
			{ beat: 0.5, freq: 659.3, length: 0.5 },
			{ beat: 1, freq: 783.99, length: 0.5 },
			{ beat: 1.5, freq: 659.3, length: 0.5 },
			{ beat: 2, freq: 523.3, length: 0.5 },
			{ beat: 2.5, freq: 659.3, length: 0.5 },
			{ beat: 3, freq: 698.5, length: 1.0 },
			{ beat: 4, freq: 523.3, length: 0.5 },
			{ beat: 4.5, freq: 659.3, length: 0.5 },
			{ beat: 5, freq: 783.99, length: 0.5 },
			{ beat: 5.5, freq: 659.3, length: 0.5 },
			{ beat: 6, freq: 587.3, length: 1.0 },
			{ beat: 7, freq: 698.5, length: 1.0 },
			{ beat: 8, freq: 523.3, length: 0.5 },
			{ beat: 8.5, freq: 659.3, length: 0.5 },
			{ beat: 9, freq: 783.99, length: 0.5 },
			{ beat: 9.5, freq: 880.0, length: 0.5 },
			{ beat: 10, freq: 783.99, length: 0.5 },
			{ beat: 10.5, freq: 659.3, length: 0.5 },
			{ beat: 11, freq: 523.3, length: 1.0 },
			{ beat: 12, freq: 880.0, length: 0.5 },
			{ beat: 12.5, freq: 783.99, length: 0.5 },
			{ beat: 13, freq: 698.5, length: 0.5 },
			{ beat: 13.5, freq: 587.3, length: 0.5 },
			{ beat: 14, freq: 523.3, length: 1.5 },
		],
		0.15,
	);
	// Woodblock pop — single-cycle sine bursts on every quarter.
	const woodExpr = (() => {
		const hits = [];
		for (let b = 0; b < 4 * bars; b++) hits.push(b * beatSec);
		const env = hits
			.map(
				(t) =>
					`exp(-90*if(lt(t-${t.toFixed(6)},0),9999,t-${t.toFixed(6)}))*sin(2*PI*1200*t)`,
			)
			.join('+');
		return `0.18*(${env})`;
	})();
	const wood = `aevalsrc='${woodExpr}':d=${totalSec.toFixed(6)}:s=${SAMPLE_RATE},bandpass=f=1500:w=900`;
	const graph = [
		`${kickPattern(bpm, bars)}[kick]`,
		`${wood}[wood]`,
		`${bass}[bass]`,
		`${lead}[lead]`,
		`[kick][wood][bass][lead]amix=inputs=4:duration=longest:normalize=0,dynaudnorm=g=11:p=0.78[mix]`,
	].join(';');
	return { graph, durationSec: totalSec };
}

// POLE — neutral 105 BPM groove for pole choreography (spin/climb/combo).
// Lower-mid sine bass + filtered noise sweep so it works under any clip.
function poleRecipe() {
	const bpm = 105;
	const bars = 4;
	const beatSec = 60 / bpm;
	const totalSec = beatSec * 4 * bars;
	const bass = basslinePattern(bpm, bars, [
		{ beat: 0, freq: 65.4 },
		{ beat: 4, freq: 87.3 },
		{ beat: 8, freq: 73.4 },
		{ beat: 12, freq: 98.0 },
	]);
	const pad = triadPattern(
		bpm,
		bars,
		[
			{ beat: 0, freq: 261.6, length: 4 },
			{ beat: 4, freq: 349.2, length: 4 },
			{ beat: 8, freq: 293.7, length: 4 },
			{ beat: 12, freq: 392.0, length: 4 },
		],
		0.14,
	);
	const graph = [
		`${kickPattern(bpm, bars)}[kick]`,
		`${hatPattern(bpm, bars)}[hat]`,
		`${bass}[bass]`,
		`${pad}[pad]`,
		`[kick][hat][bass][pad]amix=inputs=4:duration=longest:normalize=0,dynaudnorm=g=11:p=0.78[mix]`,
	].join(';');
	return { graph, durationSec: totalSec };
}

// ─── Encoder pipeline ───────────────────────────────────────────────────────

async function runFfmpeg(args, label) {
	return new Promise((resolveP, reject) => {
		const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
		let stderr = '';
		proc.stderr.on('data', (b) => {
			stderr += b.toString();
		});
		proc.on('error', reject);
		proc.on('exit', (code) => {
			if (code === 0) resolveP();
			else reject(new Error(`ffmpeg ${label} failed (${code}): ${stderr || '<no stderr>'}`));
		});
	});
}

async function buildTrack(name, recipe) {
	const { graph, durationSec } = recipe();
	const mp3Path = resolve(OUT_DIR, `${name}.mp3`);
	const oggPath = resolve(OUT_DIR, `${name}.ogg`);

	// Mono 192k MP3 — small footprint for mobile.
	await runFfmpeg(
		[
			'-filter_complex',
			graph,
			'-map',
			'[mix]',
			'-t',
			String(durationSec),
			'-ac',
			'1',
			'-ar',
			String(SAMPLE_RATE),
			'-c:a',
			'libmp3lame',
			'-b:a',
			'192k',
			'-metadata',
			`title=three.ws Pole Club — ${name}`,
			'-metadata',
			'artist=three.ws',
			'-metadata',
			'license=CC0-1.0',
			mp3Path,
		],
		`${name}.mp3`,
	);

	// Stereo q4 OGG Vorbis — better quality fallback for desktop browsers.
	await runFfmpeg(
		[
			'-filter_complex',
			graph,
			'-map',
			'[mix]',
			'-t',
			String(durationSec),
			'-ac',
			'2',
			'-ar',
			String(SAMPLE_RATE),
			'-c:a',
			'libvorbis',
			'-qscale:a',
			'4',
			'-metadata',
			`TITLE=three.ws Pole Club — ${name}`,
			'-metadata',
			'ARTIST=three.ws',
			'-metadata',
			'LICENSE=CC0-1.0',
			oggPath,
		],
		`${name}.ogg`,
	);

	const [mp3Stat, oggStat] = await Promise.all([stat(mp3Path), stat(oggPath)]);
	const maxBytes = 2 * 1024 * 1024;
	if (mp3Stat.size > maxBytes) {
		throw new Error(`${name}.mp3 is ${mp3Stat.size} bytes — exceeds 2 MB ship cap`);
	}
	if (oggStat.size > maxBytes) {
		throw new Error(`${name}.ogg is ${oggStat.size} bytes — exceeds 2 MB ship cap`);
	}
	return {
		name,
		durationSec,
		mp3Bytes: mp3Stat.size,
		oggBytes: oggStat.size,
	};
}

const TRACKS = [
	{ name: 'ambience', recipe: ambienceRecipe },
	{ name: 'rumba', recipe: rumbaRecipe },
	{ name: 'thriller', recipe: thrillerRecipe },
	{ name: 'hiphop', recipe: hiphopRecipe },
	{ name: 'capoeira', recipe: capoeiraRecipe },
	{ name: 'silly', recipe: sillyRecipe },
	{ name: 'pole', recipe: poleRecipe },
];

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const results = [];
	for (const t of TRACKS) {
		process.stdout.write(`▸ ${t.name} … `);
		const r = await buildTrack(t.name, t.recipe);
		results.push(r);
		process.stdout.write(
			`${r.durationSec.toFixed(2)}s · mp3=${(r.mp3Bytes / 1024).toFixed(1)} KiB · ogg=${(r.oggBytes / 1024).toFixed(1)} KiB\n`,
		);
	}
	const totalMp3 = results.reduce((s, r) => s + r.mp3Bytes, 0);
	const totalOgg = results.reduce((s, r) => s + r.oggBytes, 0);
	console.log(
		`\n✓ ${results.length} tracks built — total mp3=${(totalMp3 / 1024).toFixed(1)} KiB, ogg=${(totalOgg / 1024).toFixed(1)} KiB`,
	);
}

main().catch((err) => {
	console.error('\n✗ build-club-audio failed');
	console.error(err);
	process.exit(1);
});
