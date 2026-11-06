/**
 * AgentAvatar × LipSyncAnalyser — integration tests
 *
 * Exercises the full Stage-5 wiring without WebAudio or a real Three.js viewer:
 *   - a FakeAnalyserNode pretends to be an AudioContext-AnalyserNode and feeds a
 *     deterministic frequency spectrum to LipSyncAnalyser
 *   - a fake "viewer" exposes the minimum surface AgentAvatar needs to attach
 *     (an Object3D-shaped `content` with `traverse()`, an event-target `el`,
 *     and an `_afterAnimateHooks` array) and synthetic meshes carry the morph
 *     target dictionary needed by `resolveMorphTargets()`
 *
 * Two end-to-end paths are covered:
 *   1. `visemes` mode — ARKit visemes present → per-viseme weights written
 *   2. `jaw` mode     — only `jawOpen` (no visemes) → jawOpen follows amplitude
 *   plus the `none` no-op path and the disconnect/zero-out behaviour.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

// ARKit canonical viseme morph names (LipSyncAnalyser writes these).
const VISEMES = [
	'viseme_aa', 'viseme_O', 'viseme_E', 'viseme_I', 'viseme_nn',
	'viseme_SS', 'viseme_FF', 'viseme_CH', 'viseme_PP',
];

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeAnalyserNode {
	constructor({ binCount = 128, sampleRate = 48000, spectrum = null } = {}) {
		this.fftSize = binCount * 2;
		this.frequencyBinCount = binCount;
		this.smoothingTimeConstant = 0.7;
		this.context = { sampleRate };
		this._spectrum = new Uint8Array(binCount);
		if (spectrum) this.setSpectrum(spectrum);
	}
	setSpectrum(spectrum) {
		if (spectrum instanceof Uint8Array) {
			this._spectrum.set(spectrum.subarray(0, this._spectrum.length));
			return;
		}
		const binHz = this.context.sampleRate / this.fftSize;
		for (let i = 0; i < this._spectrum.length; i++) {
			const v = spectrum(i, binHz);
			this._spectrum[i] = Math.max(0, Math.min(255, v | 0));
		}
	}
	getByteFrequencyData(buf) { buf.set(this._spectrum); }
}

function makeBand(level, lowHz, highHz) {
	return (i, binHz) => {
		const f = i * binHz;
		return f >= lowHz && f < highHz ? level : 0;
	};
}

// A minimal Three.js-shaped mesh with a morphTargetDictionary that
// `resolveMorphTargets` will pick up.
function makeMesh(names) {
	const dict = {};
	for (let i = 0; i < names.length; i++) dict[names[i]] = i;
	return {
		isMesh: true,
		morphTargetDictionary: dict,
		morphTargetInfluences: new Array(names.length).fill(0),
	};
}

// Object3D-shaped root with a `traverse()` that walks itself plus a flat list
// of meshes — enough for `resolveMorphTargets()` and `_findHeadBone()`.
function makeRoot(meshes) {
	return {
		isObject3D: true,
		children: meshes,
		traverse(fn) {
			fn(this);
			for (const m of meshes) fn(m);
		},
	};
}

function makeFakeViewer(root) {
	return {
		content: root,
		_afterAnimateHooks: [],
		el: {
			addEventListener() {},
			removeEventListener() {},
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
		},
	};
}

// A minimal protocol bus — AgentAvatar.attach() subscribes to a dozen action
// types; we only need on/off/emit to be callable.
function makeFakeProtocol() {
	const listeners = new Map();
	return {
		on(type, fn) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(fn);
		},
		off(type, fn) { listeners.get(type)?.delete(fn); },
		emit(action) {
			const set = listeners.get(action.type);
			if (set) for (const fn of set) fn(action.payload);
		},
	};
}

// ── Module loading ──────────────────────────────────────────────────────────

let LipSyncAnalyser, AgentAvatar;

beforeAll(async () => {
	globalThis.AnalyserNode = FakeAnalyserNode;
	// AgentAvatar imports `three` (Vector3 / Box3 / MathUtils / PositionalAudio).
	// Those are real classes from npm — they work in node. No shim needed.
	const lsa = await import('../src/lip-sync-analyser.js');
	LipSyncAnalyser = lsa.LipSyncAnalyser;
	const av = await import('../src/agent-avatar.js');
	AgentAvatar = av.AgentAvatar;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Construct an AgentAvatar against a fake viewer + protocol, then run just
 * `_buildMorphCache()` (so `_lipsyncMode` is set) without `attach()`. Returns
 * the avatar instance and an `runStage5` helper that invokes the lipsync stage
 * directly without the other stages of _tickEmotion (which need a head bone).
 */
function makeAvatar({ meshes }) {
	const viewer = makeFakeViewer(makeRoot(meshes));
	const protocol = makeFakeProtocol();
	const identity = { id: 'test' };
	const avatar = new AgentAvatar(viewer, protocol, identity);
	avatar._buildMorphCache();
	// Isolate Stage 5 from the rest of _tickEmotion (which needs Three.js bones).
	const runStage5 = () => {
		if (!avatar._lipSync) return;
		const visemes = avatar._lipSync.sample();
		if (!visemes) return;
		if (avatar._lipsyncMode === 'visemes') {
			for (const [name, weight] of Object.entries(visemes)) {
				avatar._setMorphTarget(name, weight);
			}
			avatar._setMorphTarget('mouthOpen', 0);
		} else if (avatar._lipsyncMode === 'jaw') {
			avatar._setMorphTarget('jawOpen', avatar._lipSync.getAmplitude() * 1.8);
		}
	};
	return { avatar, runStage5 };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentAvatar × LipSyncAnalyser — integration', () => {
	describe('viseme mode (ARKit visemes present)', () => {
		let avatar, runStage5;

		beforeEach(() => {
			// Mesh exposes all 9 visemes + jawOpen — the canonical RPM/Avaturn shape.
			const mesh = makeMesh([...VISEMES, 'jawOpen', 'mouthSmileLeft', 'browInnerUp']);
			({ avatar, runStage5 } = makeAvatar({ meshes: [mesh] }));
		});

		it('detects visemes mode at build time', () => {
			expect(avatar._lipsyncMode).toBe('visemes');
		});

		it('writes per-viseme morph targets and suppresses mouthOpen while speaking', () => {
			const analyser = new FakeAnalyserNode({ spectrum: makeBand(220, 0, 500) });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 40; i++) runStage5();
			expect(avatar._morphTarget.viseme_aa).toBeGreaterThan(0);
			expect(avatar._morphTarget.viseme_O).toBeGreaterThan(0);
			// Low-freq energy → open vowels should dominate sibilants.
			expect(avatar._morphTarget.viseme_aa).toBeGreaterThan(avatar._morphTarget.viseme_SS);
			expect(avatar._morphTarget.mouthOpen).toBe(0);
		});

		it('disconnectLipSync() zeros every viseme target so the lerp fades the mouth out', () => {
			const analyser = new FakeAnalyserNode({ spectrum: makeBand(220, 0, 500) });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 40; i++) runStage5();
			expect(avatar._morphTarget.viseme_aa).toBeGreaterThan(0.01);

			avatar.disconnectLipSync();
			for (const name of VISEMES) expect(avatar._morphTarget[name]).toBe(0);
			expect(avatar._morphTarget.mouthOpen).toBe(0);
			expect(avatar._morphTarget.jawOpen).toBe(0);
			expect(avatar._lipSync).toBeNull();
		});
	});

	describe('jaw mode (no visemes, jawOpen present)', () => {
		let avatar, runStage5;

		beforeEach(() => {
			// Plain humanoid rig: jawOpen + a couple of expression morphs, no visemes.
			const mesh = makeMesh(['jawOpen', 'mouthSmileLeft', 'browInnerUp']);
			({ avatar, runStage5 } = makeAvatar({ meshes: [mesh] }));
		});

		it('detects jaw mode at build time', () => {
			expect(avatar._lipsyncMode).toBe('jaw');
		});

		it('drives jawOpen from smoothed amplitude and leaves visemes untouched', () => {
			const analyser = new FakeAnalyserNode({ spectrum: () => 220 });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 40; i++) runStage5();

			expect(avatar._morphTarget.jawOpen).toBeGreaterThan(0.5);
			expect(avatar._morphTarget.jawOpen).toBeLessThanOrEqual(1.0);
			// Visemes never set in this mode.
			for (const v of VISEMES) {
				expect(avatar._morphTarget[v] ?? 0).toBe(0);
			}
		});

		it('jawOpen tracks amplitude — silence pulls it back toward zero', () => {
			const analyser = new FakeAnalyserNode({ spectrum: () => 220 });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 40; i++) runStage5();
			const peak = avatar._morphTarget.jawOpen;
			expect(peak).toBeGreaterThan(0.5);

			analyser.setSpectrum(() => 0);
			for (let i = 0; i < 40; i++) runStage5();
			expect(avatar._morphTarget.jawOpen).toBeLessThan(peak * 0.1);
		});

		it('disconnectLipSync() zeros jawOpen even though no visemes were ever written', () => {
			const analyser = new FakeAnalyserNode({ spectrum: () => 220 });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 40; i++) runStage5();
			expect(avatar._morphTarget.jawOpen).toBeGreaterThan(0.01);

			avatar.disconnectLipSync();
			expect(avatar._morphTarget.jawOpen).toBe(0);
			expect(avatar._lipSync).toBeNull();
		});
	});

	describe('none mode (no relevant morphs)', () => {
		it('detects none mode and Stage 5 writes nothing morph-related', () => {
			const mesh = makeMesh(['browInnerUp', 'eyeBlinkLeft']);
			const { avatar, runStage5 } = makeAvatar({ meshes: [mesh] });
			expect(avatar._lipsyncMode).toBe('none');

			const analyser = new FakeAnalyserNode({ spectrum: () => 220 });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 40; i++) runStage5();
			// Lipsync stage no-ops; viseme + jaw targets stay untouched.
			for (const v of VISEMES) expect(avatar._morphTarget[v] ?? 0).toBe(0);
			expect(avatar._morphTarget.jawOpen ?? 0).toBe(0);
		});
	});

	// ── Edge cases ─────────────────────────────────────────────────────────────
	// The following four describes cover production scenarios the happy-path
	// tests above don't reach: very short audio bursts, true silence (FFT floor),
	// back-to-back utterances (state isolation across reconnect), and browsers
	// without AnalyserNode (graceful no-op). See tests/agent-avatar-lipsync —
	// each block targets one of those four behaviours.

	describe('very short audio (< 200 ms)', () => {
		it('after only ~5 frames, every viseme weight is a finite number in [0, 1]', () => {
			const mesh = makeMesh([...VISEMES, 'jawOpen', 'mouthSmileLeft', 'browInnerUp']);
			const { avatar, runStage5 } = makeAvatar({ meshes: [mesh] });

			const analyser = new FakeAnalyserNode({ spectrum: makeBand(220, 0, 500) });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 5; i++) runStage5();

			for (const v of VISEMES) {
				const w = avatar._morphTarget[v] ?? 0;
				expect(Number.isFinite(w)).toBe(true);
				expect(w).toBeGreaterThanOrEqual(0);
				expect(w).toBeLessThanOrEqual(1);
			}
			// Amplitude tracking should also be bounded and finite this early.
			const amp = avatar._lipSync.getAmplitude();
			expect(Number.isFinite(amp)).toBe(true);
			expect(amp).toBeGreaterThanOrEqual(0);
			expect(amp).toBeLessThanOrEqual(1);
		});
	});

	describe('silence — all FFT bins read 0 from the start', () => {
		it('every band-driven viseme stays ≤ 0.05 (no FFT-floor leakage to the mouth)', () => {
			const mesh = makeMesh([...VISEMES, 'jawOpen', 'mouthSmileLeft', 'browInnerUp']);
			const { avatar, runStage5 } = makeAvatar({ meshes: [mesh] });

			const analyser = new FakeAnalyserNode({ spectrum: () => 0 });
			avatar.connectLipSync(analyser);
			for (let i = 0; i < 20; i++) runStage5();

			// All three band groups (low → aa/O, mid → E/I/nn, high → SS/FF/CH)
			// plus the bilabial PP must stay near zero — the small epsilon allows
			// for the silence-branch lerp residual without permitting real motion.
			for (const v of VISEMES) {
				expect(avatar._morphTarget[v] ?? 0).toBeLessThanOrEqual(0.05);
			}
			expect(avatar._lipSync.getAmplitude()).toBeLessThanOrEqual(0.05);
		});
	});

	describe('back-to-back utterances — no state bleed across reconnect', () => {
		it('detach after utterance A, attach for utterance B → output reflects only B', () => {
			const mesh = makeMesh([...VISEMES, 'jawOpen', 'mouthSmileLeft', 'browInnerUp']);
			const { avatar, runStage5 } = makeAvatar({ meshes: [mesh] });

			// Utterance A: low-frequency energy → drives viseme_aa up, viseme_SS stays cold.
			const sourceA = new FakeAnalyserNode({ spectrum: makeBand(220, 0, 500) });
			avatar.connectLipSync(sourceA);
			for (let i = 0; i < 40; i++) runStage5();
			expect(avatar._morphTarget.viseme_aa).toBeGreaterThan(avatar._morphTarget.viseme_SS);

			// Tear down. AgentAvatar.disconnectLipSync() drops the analyser and zeros
			// every viseme target — confirms detach side of the contract.
			avatar.disconnectLipSync();
			expect(avatar._lipSync).toBeNull();
			for (const v of VISEMES) expect(avatar._morphTarget[v]).toBe(0);

			// Re-attach with utterance B: high-frequency sibilant energy. The new
			// LipSyncAnalyser instance must start with clean smoothing buffers —
			// otherwise residual viseme_aa weight from A would survive the swap.
			const sourceB = new FakeAnalyserNode({ spectrum: makeBand(220, 2000, 8000) });
			avatar.connectLipSync(sourceB);
			expect(avatar._lipSync._prevAmplitude).toBe(0);
			for (const v of VISEMES) expect(avatar._lipSync._prev[v]).toBe(0);

			for (let i = 0; i < 40; i++) runStage5();

			// B's signal is sibilant, so viseme_SS must now dominate viseme_aa —
			// the opposite ordering from utterance A. If A's state had bled through,
			// viseme_aa would still carry weight from the first 40 frames.
			expect(avatar._morphTarget.viseme_SS).toBeGreaterThan(avatar._morphTarget.viseme_aa);
		});
	});

	describe('browser without AnalyserNode — graceful no-op', () => {
		let savedAnalyserNode;
		beforeEach(() => {
			savedAnalyserNode = globalThis.AnalyserNode;
			// Older Safari iOS lock-screen contexts and some embedded WebViews
			// don't expose AnalyserNode. Simulate that here.
			globalThis.AnalyserNode = undefined;
		});
		afterEach(() => {
			globalThis.AnalyserNode = savedAnalyserNode;
		});

		it('connectLipSync + Stage 5 do not throw; mouth sits at rest (all zeros)', () => {
			const mesh = makeMesh([...VISEMES, 'jawOpen', 'mouthSmileLeft', 'browInnerUp']);
			const { avatar, runStage5 } = makeAvatar({ meshes: [mesh] });

			// Even a structurally-valid analyser object can't pass `instanceof
			// AnalyserNode` once the constructor is gone, so connect() returns
			// early and the driver stays inactive — exactly the production fallback.
			const source = new FakeAnalyserNode({ spectrum: makeBand(220, 0, 500) });

			expect(() => avatar.connectLipSync(source)).not.toThrow();
			expect(avatar._lipSync).not.toBeNull();
			expect(avatar._lipSync._active).toBe(false);

			expect(() => {
				for (let i = 0; i < 5; i++) runStage5();
			}).not.toThrow();

			// Driver inactive → sample() returns null → Stage 5 writes nothing →
			// mouth sits at rest at all the targets the lipsync path touches.
			for (const v of VISEMES) expect(avatar._morphTarget[v] ?? 0).toBe(0);
			expect(avatar._morphTarget.jawOpen ?? 0).toBe(0);
			expect(avatar._morphTarget.mouthOpen ?? 0).toBe(0);
		});
	});
});
