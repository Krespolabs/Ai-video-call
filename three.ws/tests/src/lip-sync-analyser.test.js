/**
 * three.ws — LipSyncAnalyser unit tests
 *
 * Exercises the spectral analyser without WebAudio by injecting a fake
 * AnalyserNode whose `getByteFrequencyData()` writes a deterministic
 * frequency spectrum. The module under test does an `instanceof AnalyserNode`
 * check, so we shim a real constructor on globalThis before importing.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Shim AnalyserNode globally before the SUT is imported. The SUT uses
// `audioSource instanceof AnalyserNode` to route to its analyser branch,
// so the stub must extend this class.
class FakeAnalyserNode {
	constructor({ binCount = 128, sampleRate = 44100 } = {}) {
		this.fftSize = binCount * 2;
		this.frequencyBinCount = binCount;
		this.smoothingTimeConstant = 0.7;
		this.context = { sampleRate };
		this._spectrum = new Uint8Array(binCount);
	}
	setSpectrum(buf) {
		this._spectrum.set(buf.subarray(0, this._spectrum.length));
	}
	fillRange(start, end, value) {
		for (let i = start; i < Math.min(end, this._spectrum.length); i++) {
			this._spectrum[i] = value;
		}
	}
	clear() {
		this._spectrum.fill(0);
	}
	getByteFrequencyData(out) {
		out.set(this._spectrum.subarray(0, out.length));
	}
	disconnect() {}
}

globalThis.AnalyserNode = FakeAnalyserNode;

let LipSyncAnalyser;
let VISEMES;

beforeAll(async () => {
	const mod = await import('../../src/lip-sync-analyser.js');
	LipSyncAnalyser = mod.LipSyncAnalyser;
	VISEMES = mod.VISEMES;
});

const EXPECTED_VISEMES = [
	'viseme_aa', 'viseme_O', 'viseme_E', 'viseme_I', 'viseme_nn',
	'viseme_SS', 'viseme_FF', 'viseme_CH', 'viseme_PP',
];

describe('three.ws LipSyncAnalyser — constructor', () => {
	it('initialises inactive with all nine viseme weights at zero', () => {
		const a = new LipSyncAnalyser();
		expect(a._active).toBe(false);
		for (const k of EXPECTED_VISEMES) {
			expect(a._out[k]).toBe(0);
		}
		// Sanity — the exported VISEMES list must match the 9 we contract on.
		expect(VISEMES.slice().sort()).toEqual(EXPECTED_VISEMES.slice().sort());
	});

	it('exposes a zero amplitude before any sample()', () => {
		const a = new LipSyncAnalyser();
		expect(a.getAmplitude()).toBe(0);
	});
});

describe('three.ws LipSyncAnalyser — sample() lifecycle', () => {
	it('returns null when sample() is called before connect()', () => {
		const a = new LipSyncAnalyser();
		expect(a.sample()).toBeNull();
	});

	it('returns a viseme map with all nine keys and weights in [0,1] after connect()', () => {
		const a = new LipSyncAnalyser();
		const stub = new FakeAnalyserNode();
		// Known pattern — linear ramp 0..255 across the bins.
		for (let i = 0; i < stub.frequencyBinCount; i++) {
			stub._spectrum[i] = Math.floor((i / (stub.frequencyBinCount - 1)) * 255);
		}
		a.connect(stub);
		const out = a.sample();
		expect(out).not.toBeNull();
		expect(typeof out).toBe('object');
		for (const k of EXPECTED_VISEMES) {
			expect(out).toHaveProperty(k);
			expect(out[k]).toBeGreaterThanOrEqual(0);
			expect(out[k]).toBeLessThanOrEqual(1);
		}
	});
});

describe('three.ws LipSyncAnalyser — spectral mapping', () => {
	it('decays every viseme toward zero on silence', () => {
		const a = new LipSyncAnalyser();
		const stub = new FakeAnalyserNode();
		a.connect(stub);

		// Prime the EMA with a non-zero frame, then go silent for many frames.
		stub.fillRange(0, stub.frequencyBinCount, 200);
		a.sample();
		stub.clear();
		let out;
		for (let n = 0; n < 30; n++) out = a.sample();
		for (const k of EXPECTED_VISEMES) {
			expect(out[k]).toBeLessThan(0.1);
		}
		expect(a.getAmplitude()).toBeLessThan(0.1);
	});

	it('drives viseme_aa and viseme_O on low-band energy', () => {
		const a = new LipSyncAnalyser();
		const stub = new FakeAnalyserNode();
		a.connect(stub);

		// Concentrate energy in the low band — bins covering 0..500 Hz.
		// At 44.1 kHz / fft=256, binHz ≈ 172, so lowEnd ≈ 3 bins.
		// Saturate the entire low band to 255, leave the rest at 0.
		stub.fillRange(0, a._lowEnd, 255);

		// Drive the EMA to steady state.
		let out;
		for (let n = 0; n < 40; n++) out = a.sample();

		expect(out.viseme_aa).toBeGreaterThan(0.3);
		expect(out.viseme_O).toBeGreaterThan(0.3);
		// High-band visemes must stay quiet.
		expect(out.viseme_SS).toBeLessThan(out.viseme_aa);
		expect(out.viseme_FF).toBeLessThan(out.viseme_aa);
	});

	it('drives viseme_SS and viseme_FF on high-band energy', () => {
		const a = new LipSyncAnalyser();
		const stub = new FakeAnalyserNode();
		a.connect(stub);

		// Concentrate energy in the high band — bins covering 2k..8k Hz.
		stub.fillRange(a._midEnd, a._highEnd, 255);

		let out;
		for (let n = 0; n < 40; n++) out = a.sample();

		expect(out.viseme_SS).toBeGreaterThan(0.3);
		expect(out.viseme_FF).toBeGreaterThan(0.3);
		// Low-band visemes must stay quiet.
		expect(out.viseme_aa).toBeLessThan(out.viseme_SS);
		expect(out.viseme_O).toBeLessThan(out.viseme_SS);
	});
});

describe('three.ws LipSyncAnalyser — disconnect()', () => {
	it('resets _active, zeroes the viseme map, and makes subsequent sample() return null', () => {
		const a = new LipSyncAnalyser();
		const stub = new FakeAnalyserNode();
		a.connect(stub);

		// Prime with energy so the output map is non-zero before disconnecting.
		stub.fillRange(0, stub.frequencyBinCount, 255);
		for (let n = 0; n < 10; n++) a.sample();
		// At least one viseme is non-zero now.
		expect(EXPECTED_VISEMES.some((k) => a._out[k] > 0)).toBe(true);

		a.disconnect();

		expect(a._active).toBe(false);
		for (const k of EXPECTED_VISEMES) {
			expect(a._out[k]).toBe(0);
		}
		expect(a.getAmplitude()).toBe(0);
		expect(a.sample()).toBeNull();
	});
});
