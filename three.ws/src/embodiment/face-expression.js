/**
 * FaceExpression — applies an emotional face onto a rig, with graceful fallback.
 *
 * Emotion descriptors come from src/embodiment/emotion.js as ARKit-style
 * blendshape weights. This applier binds those channels to whatever the rig
 * actually exposes and eases them on/off so a mood shift reads as a transition,
 * not a pop:
 *
 *   • morph mode — the mesh carries expression morph targets (mouthSmileLeft,
 *     browDownLeft, …). We drive them directly; the lip-sync driver owns the
 *     mouth/viseme morphs, so we only touch the EXPRESSION_CHANNELS set.
 *   • bone mode — no expression morphs, but the rig has brow bones. We can't do
 *     a full face, but raising/furrowing the brows carries most of the read for
 *     surprise vs. anger, so we rotate the brow bones instead.
 *   • none — no facial rig at all. Every call is a safe no-op.
 *
 * Reduced motion snaps the target on instantly (a face is communicative; a
 * person who prefers reduced motion still wants to see the emotion, just not
 * the animation into it). dispose() releases everything it drove back to rest.
 */

import { expressionFor, EXPRESSION_CHANNELS } from './emotion.js';

export { EXPRESSION_CHANNELS };

// Per-tick ease toward the target weights. Tuned so ~3 ticks land the face.
const EASE = 0.5;
// Brow-bone pitch (radians) at full intensity. Negative raises, positive furrows.
const BROW_RAISE = -0.35;
const BROW_FURROW = 0.3;

function clamp01(n) {
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

export class FaceExpression {
	/**
	 * @param {{ reducedMotion?: boolean }} [options]
	 */
	constructor(options = {}) {
		this.reducedMotion = !!(options && options.reducedMotion);
		this.mode = 'none';
		this.emotion = 'neutral';

		// morph mode: meshes carrying expression morphs, the channel→index map,
		// and the current vs. target weight per channel.
		this._meshes = [];
		this._channelTargets = {};
		this._channelWeights = {};

		// bone mode: brow bones and their resting pitch.
		this._browBones = [];
		this._browRest = new Map();
		this._browTarget = 0;
		this._browCurrent = 0;
	}

	/**
	 * Bind to a traversable Three.js root and decide the applier mode.
	 *
	 * @param {{ traverse?: (fn: (node: any) => void) => void }} root
	 */
	attach(root) {
		this._reset();
		if (!root || typeof root.traverse !== 'function') {
			this.mode = 'none';
			return;
		}

		const browBones = [];
		root.traverse((node) => {
			if (!node) return;
			if (node.isMesh && node.morphTargetDictionary && node.morphTargetInfluences) {
				const channels = EXPRESSION_CHANNELS.filter(
					(c) => node.morphTargetDictionary[c] !== undefined,
				);
				if (channels.length) {
					this._meshes.push({ mesh: node, channels });
				}
			}
			if ((node.isBone || node.type === 'Bone') && /brow/i.test(node.name || '')) {
				browBones.push(node);
			}
		});

		if (this._meshes.length) {
			this.mode = 'morph';
			for (const channel of EXPRESSION_CHANNELS) {
				this._channelTargets[channel] = 0;
				this._channelWeights[channel] = 0;
			}
		} else if (browBones.length) {
			this.mode = 'bone';
			this._browBones = browBones;
			for (const bone of browBones) {
				this._browRest.set(bone, bone.rotation.x);
			}
		} else {
			this.mode = 'none';
		}
	}

	/**
	 * Set the face to an emotion at the given intensity.
	 *
	 * @param {string} emotion
	 * @param {number} [intensity=0.6]
	 */
	setEmotion(emotion, intensity = 0.6) {
		const descriptor = expressionFor(emotion, intensity);
		this.emotion = descriptor.emotion;

		if (this.mode === 'morph') {
			for (const channel of EXPRESSION_CHANNELS) {
				this._channelTargets[channel] = clamp01(descriptor.face[channel] || 0);
			}
			if (this.reducedMotion) this._snap();
			return;
		}

		if (this.mode === 'bone') {
			// Lift on any brow-up read (surprised), furrow on brow-down (angry),
			// otherwise rest. Scaled by intensity.
			const strength = descriptor.intensity;
			const up = (descriptor.face.browInnerUp || 0) + (descriptor.face.browOuterUpLeft || 0);
			const down = (descriptor.face.browDownLeft || 0) + (descriptor.face.browDownRight || 0);
			if (up > down) this._browTarget = BROW_RAISE * strength;
			else if (down > up) this._browTarget = BROW_FURROW * strength;
			else this._browTarget = 0;
			if (this.reducedMotion) this._snap();
		}
	}

	/**
	 * Release the face back to neutral (eases off over subsequent ticks).
	 */
	clear() {
		this.emotion = 'neutral';
		if (this.mode === 'morph') {
			for (const channel of EXPRESSION_CHANNELS) this._channelTargets[channel] = 0;
		} else if (this.mode === 'bone') {
			this._browTarget = 0;
		}
		if (this.reducedMotion) this._snap();
	}

	/**
	 * Advance the ease toward the current target. dt is accepted for API parity
	 * with the rest of the embodiment stage; the ease is per-tick.
	 *
	 * @param {number} [dt]
	 */
	update(dt) {
		void dt;
		if (this.mode === 'morph') {
			for (const channel of EXPRESSION_CHANNELS) {
				const target = this._channelTargets[channel];
				this._channelWeights[channel] += (target - this._channelWeights[channel]) * EASE;
			}
			this._writeMorphs();
		} else if (this.mode === 'bone') {
			this._browCurrent += (this._browTarget - this._browCurrent) * EASE;
			this._writeBrows();
		}
	}

	/**
	 * Unbind, releasing every morph/bone this applier drove back to rest.
	 */
	dispose() {
		this._reset();
		this.mode = 'none';
		this.emotion = 'neutral';
	}

	// ── internals ──────────────────────────────────────────────────────────

	_snap() {
		if (this.mode === 'morph') {
			for (const channel of EXPRESSION_CHANNELS) {
				this._channelWeights[channel] = this._channelTargets[channel];
			}
			this._writeMorphs();
		} else if (this.mode === 'bone') {
			this._browCurrent = this._browTarget;
			this._writeBrows();
		}
	}

	_writeMorphs() {
		for (const { mesh, channels } of this._meshes) {
			for (const channel of channels) {
				const idx = mesh.morphTargetDictionary[channel];
				mesh.morphTargetInfluences[idx] = this._channelWeights[channel];
			}
		}
	}

	_writeBrows() {
		for (const bone of this._browBones) {
			const rest = this._browRest.get(bone) || 0;
			bone.rotation.x = rest + this._browCurrent;
		}
	}

	// Zero everything we drove and forget our bindings.
	_reset() {
		for (const { mesh, channels } of this._meshes) {
			for (const channel of channels) {
				const idx = mesh.morphTargetDictionary[channel];
				if (idx !== undefined) mesh.morphTargetInfluences[idx] = 0;
			}
		}
		for (const bone of this._browBones) {
			bone.rotation.x = this._browRest.get(bone) || 0;
		}
		this._meshes = [];
		this._channelTargets = {};
		this._channelWeights = {};
		this._browBones = [];
		this._browRest = new Map();
		this._browTarget = 0;
		this._browCurrent = 0;
	}
}
