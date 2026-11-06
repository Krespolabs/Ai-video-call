/**
 * EmbodimentController — the glue that makes a persona's reply *land* on a rig:
 * it lip-syncs the mouth, picks the emotion the line carries, drives the face,
 * and routes a body gesture. One call to say() does all of it.
 *
 * Two lip-sync lanes:
 *   • audio — when the caller hands us live audio, a Web-Audio analyser drives
 *     the mouth off the real waveform (owned by the renderer, self-driving via
 *     requestAnimationFrame). Not available headless.
 *   • text — the deterministic TextVisemeEnvelope (src/embodiment/text-visemes.js)
 *     times the mouth off the words themselves. This is the fallback lane and
 *     the one update() advances; it ends on its own and clears the mouth.
 *
 * Emotion is classified from the spoken line (src/embodiment/emotion.js), eased
 * onto the face (FaceExpression), and escalated into a body gesture routed
 * through the AnimationManager — high-intensity emotions fire their peak clip
 * and settle back to idle, neutral simply crossfades to idle. Reduced motion
 * suppresses body gestures but keeps the (communicative) face.
 */

import { detectEmotion, expressionFor } from './emotion.js';
import { FaceExpression } from './face-expression.js';
import { TextVisemeEnvelope, estimateSpeechDuration } from './text-visemes.js';
import { inspectRig, decideRigMode } from './rig-mode.js';

function clamp01(n) {
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

export class EmbodimentController {
	/**
	 * @param {{ onSpeakEnd?: () => void, animationManager?: object, reducedMotion?: boolean }} [options]
	 */
	constructor(options = {}) {
		this.onSpeakEnd = typeof options.onSpeakEnd === 'function' ? options.onSpeakEnd : null;
		this.animationManager = options.animationManager || null;
		this.reducedMotion = !!options.reducedMotion;

		this.rig = null;
		this.faceMode = 'none';
		this.speaking = false;

		this._face = new FaceExpression({ reducedMotion: this.reducedMotion });
		this._jawMeshes = [];

		// Active text-lane utterance state.
		this._envelope = null;
		this._elapsed = 0;
	}

	/**
	 * Bind to a traversable Three.js root. Returns the rig decision so the caller
	 * can show which animation mode the avatar landed in.
	 *
	 * @param {{ traverse?: (fn: (node: any) => void) => void }} root
	 * @returns {{ mode: string, reason: string, canonicalCount: number, hasSkinnedMesh: boolean }}
	 */
	attach(root) {
		this.rig = decideRigMode(inspectRig(root));

		this._face.attach(root);
		this.faceMode = this._face.mode;

		// Collect the mouth (jawOpen) morphs the text lane drives directly. The
		// face applier deliberately leaves mouth/viseme morphs to lip-sync.
		this._jawMeshes = [];
		if (root && typeof root.traverse === 'function') {
			root.traverse((node) => {
				if (node && node.isMesh && node.morphTargetDictionary && node.morphTargetInfluences) {
					const idx = node.morphTargetDictionary.jawOpen;
					if (idx !== undefined) this._jawMeshes.push({ mesh: node, idx });
				}
			});
		}

		return this.rig;
	}

	/**
	 * Speak a line: classify its emotion, drive the face + gesture, and start the
	 * text lip-sync envelope. Returns a handle exposing the estimated duration
	 * and a stop() to cut it short.
	 *
	 * @param {string} text
	 * @returns {{ duration: number, stop: () => void }}
	 */
	say(text) {
		const line = typeof text === 'string' ? text : '';
		const { emotion, intensity } = detectEmotion(line);
		this.setEmotion(emotion, intensity);

		this._envelope = new TextVisemeEnvelope(line, {});
		this._elapsed = 0;
		this.speaking = true;

		return {
			duration: this._envelope.duration || estimateSpeechDuration(line),
			stop: () => this.stop(),
		};
	}

	/**
	 * Apply an emotion: ease the face on and route the body gesture. High
	 * intensity fires the emotion's peak clip and settles back to idle; an
	 * emotion with no gesture (neutral) just crossfades to idle. Reduced motion
	 * keeps the face but suppresses the body gesture.
	 *
	 * @param {string} emotion
	 * @param {number} [intensity=0.6]
	 */
	setEmotion(emotion, intensity = 0.6) {
		const descriptor = expressionFor(emotion, intensity);
		this._face.setEmotion(descriptor.emotion, descriptor.intensity);

		if (this.reducedMotion) return;

		const am = this.animationManager;
		if (!am) return;

		if (descriptor.gesture && typeof am.playOnce === 'function') {
			if (typeof am.canPlay !== 'function' || am.canPlay(descriptor.gesture)) {
				am.playOnce(descriptor.gesture, { settleTo: descriptor.idle });
				return;
			}
		}
		if (typeof am.crossfadeTo === 'function') am.crossfadeTo(descriptor.idle);
	}

	/**
	 * Advance the active utterance and the face ease by dt seconds.
	 *
	 * @param {number} dt
	 */
	update(dt) {
		const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
		this._face.update(step);

		if (!this.speaking || !this._envelope) return;

		this._elapsed += step;
		const shape = this._envelope.sample(this._elapsed);
		this._writeJaw(clamp01(shape.open));

		if (this._envelope.done(this._elapsed)) {
			// Give the mouth a beat to ease shut, then end the utterance.
			if (this._elapsed >= this._envelope.duration && shape.open < 0.02) {
				this._endSpeech(true);
			}
		}
	}

	/**
	 * Cut the current utterance short and shut the mouth. Does not re-fire
	 * onSpeakEnd — a manual stop isn't a natural completion.
	 */
	stop() {
		if (!this.speaking) return;
		this._endSpeech(false);
	}

	/**
	 * Unbind everything and release the face.
	 */
	dispose() {
		this.stop();
		this._face.dispose();
		this.faceMode = 'none';
		this._jawMeshes = [];
		this._envelope = null;
		this.rig = null;
		this.animationManager = null;
	}

	// ── internals ──────────────────────────────────────────────────────────

	_endSpeech(natural) {
		this.speaking = false;
		this._envelope = null;
		this._elapsed = 0;
		this._writeJaw(0);
		if (natural && this.onSpeakEnd) this.onSpeakEnd();
	}

	_writeJaw(value) {
		for (const { mesh, idx } of this._jawMeshes) {
			mesh.morphTargetInfluences[idx] = value;
		}
	}
}
