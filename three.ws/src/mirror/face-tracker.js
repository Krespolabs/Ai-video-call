/**
 * FaceTracker — webcam → live face landmarks for the "become your agent" mirror.
 *
 * Wraps Google MediaPipe FaceLandmarker (`@mediapipe/tasks-vision`) into a tiny,
 * dependency-light driver that turns a user's webcam feed into a stream of
 * normalized {@link FaceFrame}s: ARKit-style blendshape weights plus a decoded
 * head pose (pitch / yaw / roll). A consuming module maps those onto a 3D avatar
 * each frame so the user's face drives the model in real time.
 *
 * Design notes
 * ------------
 * - VIDEO running mode, one face, blendshapes + facial transformation matrices on.
 * - The detection loop prefers `requestVideoFrameCallback` (fires once per decoded
 *   video frame, no wasted work) and falls back to `requestAnimationFrame`.
 * - MediaPipe's `detectForVideo` throws if the timestamp is not strictly
 *   monotonically increasing and processes nothing useful if you feed it the same
 *   video frame twice — so we track `lastVideoTime` (skip unchanged frames) and a
 *   `lastTimestamp` watermark (force-bump the timestamp we pass so it always rises).
 * - Head pose is decoded from the 4x4 column-major facial transformation matrix via
 *   THREE: Matrix4 → decompose → Euler('YXZ'). yaw=y, pitch=x, roll=z (radians).
 * - Light exponential smoothing on blendshapes + angles keeps the avatar from
 *   jittering; the consumer smooths again, so this stays intentionally gentle.
 * - Assets (WASM fileset + .task model) are vendored locally and served from
 *   `${localBasePath}` (default `/vendor/mediapipe`). If local load fails we retry
 *   once from the pinned official CDN before surfacing a 'model-load' error.
 *
 * The module is pure: it creates no DOM, injects no CSS, and touches no globals.
 * Its only side effect is on the <video> element handed to {@link FaceTracker#start}.
 *
 * @example
 *   const tracker = new FaceTracker({ smoothing: 0.5 });
 *   tracker.onStatus = (s) => console.log('status', s);
 *   tracker.onError  = (e) => console.error(e.code, e.message);
 *   tracker.onFrame  = (frame) => {
 *     if (!frame.present) return;
 *     avatar.applyBlendshapes(frame.blendshapes);
 *     avatar.applyHead(frame.head);
 *   };
 *   await tracker.init();
 *   await tracker.start(document.querySelector('video'));
 *   // …later…
 *   tracker.stop();
 *   tracker.dispose();
 *
 * @typedef {Object} FaceFrame
 * @property {boolean} present     True if a face was detected this frame.
 * @property {Object<string, number>} blendshapes  ARKit blendshape name → 0..1 weight. Empty when no face.
 * @property {{pitch:number, yaw:number, roll:number}|null} head  Head pose in radians, or null when no face.
 * @property {number} ts           `performance.now()` timestamp of the frame.
 */

import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import * as THREE from 'three';

/** Official pinned CDN fallbacks (must match the installed library version). */
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const CDN_MODEL =
	'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * Wrap a value in an Error carrying a stable `.code`, preserving the original
 * message/cause when one is supplied.
 *
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {Error & { code: string }}
 */
function trackerError(code, message, cause) {
	const err = /** @type {Error & { code: string }} */ (
		new Error(cause instanceof Error ? `${message}: ${cause.message}` : message)
	);
	err.code = code;
	if (cause !== undefined) err.cause = cause;
	return err;
}

/** Linear interpolation. */
function lerp(a, b, t) {
	return a + (b - a) * t;
}

export class FaceTracker {
	/**
	 * @param {Object} [opts]
	 * @param {string} [opts.localBasePath='/vendor/mediapipe'] Base path for the vendored WASM dir + model.
	 * @param {number} [opts.smoothing=0.5] 0..1 smoothing factor (0 = none/instant, 1 = frozen). Light values feel best.
	 */
	constructor(opts = {}) {
		this._localBasePath = (opts.localBasePath ?? '/vendor/mediapipe').replace(/\/+$/, '');
		// Clamp smoothing to a sane range; this is the per-frame lerp blend toward the new value.
		const s = Number.isFinite(opts.smoothing) ? opts.smoothing : 0.5;
		this._smoothing = Math.min(0.95, Math.max(0, s));

		/** @type {FaceLandmarker|null} */
		this._landmarker = null;
		/** @type {Promise<void>|null} Guards concurrent init() calls. */
		this._initPromise = null;

		/** @type {HTMLVideoElement|null} */
		this._video = null;
		/** @type {MediaStream|null} */
		this._stream = null;
		this._running = false;

		// Loop bookkeeping.
		this._rafId = 0;
		this._rvfcId = 0;
		this._useRvfc = false;
		this._lastVideoTime = -1; // last video currentTime we actually ran detection on
		this._lastTimestamp = -1; // monotonic watermark for detectForVideo()

		// Smoothing caches.
		/** @type {Object<string, number>} */
		this._smoothedShapes = {};
		/** @type {{pitch:number, yaw:number, roll:number}|null} */
		this._smoothedHead = null;
		this._wasPresent = false;

		// Reused THREE scratch objects (avoid per-frame allocation).
		this._mat4 = new THREE.Matrix4();
		this._pos = new THREE.Vector3();
		this._quat = new THREE.Quaternion();
		this._scale = new THREE.Vector3();
		this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

		// Consumer-assignable callbacks. Default to no-ops so calls are always safe.
		/** @type {(frame: FaceFrame) => void} */
		this.onFrame = () => {};
		/** @type {(status: 'idle'|'loading-model'|'requesting-camera'|'running'|'stopped'|'no-face') => void} */
		this.onStatus = () => {};
		/** @type {(err: Error & { code: string }) => void} */
		this.onError = () => {};

		this._status = 'idle';
	}

	/** @returns {boolean} Whether the detection loop is currently active. */
	get running() {
		return this._running;
	}

	/** @returns {HTMLVideoElement|null} The bound video element, or null before start(). */
	get videoElement() {
		return this._video;
	}

	/**
	 * Load the MediaPipe fileset + create the FaceLandmarker. Idempotent: repeated
	 * calls share the same in-flight promise and resolve once the landmarker exists.
	 *
	 * @returns {Promise<void>}
	 */
	async init() {
		if (this._landmarker) return;
		if (this._initPromise) return this._initPromise;

		this._initPromise = this._loadLandmarker().catch((err) => {
			// Reset so a later init() can retry from scratch.
			this._initPromise = null;
			throw err;
		});
		return this._initPromise;
	}

	/**
	 * Build the FaceLandmarker, trying local vendored assets first and falling
	 * back once to the pinned CDN. Emits 'loading-model' while working.
	 *
	 * @private
	 * @returns {Promise<void>}
	 */
	async _loadLandmarker() {
		this._setStatus('loading-model');

		const localWasm = `${this._localBasePath}/wasm`;
		const localModel = `${this._localBasePath}/face_landmarker.task`;

		try {
			this._landmarker = await this._createLandmarker(localWasm, localModel);
		} catch (localErr) {
			console.warn(
				'[FaceTracker] Local MediaPipe assets failed to load, falling back to CDN.',
				localErr
			);
			try {
				this._landmarker = await this._createLandmarker(CDN_WASM, CDN_MODEL);
			} catch (cdnErr) {
				const err = trackerError(
					'model-load',
					'Failed to load the face tracking model from local assets and the CDN fallback',
					cdnErr
				);
				this._emitError(err);
				throw err;
			}
		}
	}

	/**
	 * Resolve the WASM fileset and create a VIDEO-mode FaceLandmarker.
	 *
	 * @private
	 * @param {string} wasmPath
	 * @param {string} modelPath
	 * @returns {Promise<FaceLandmarker>}
	 */
	async _createLandmarker(wasmPath, modelPath) {
		const fileset = await FilesetResolver.forVisionTasks(wasmPath);
		return FaceLandmarker.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: modelPath },
			runningMode: 'VIDEO',
			numFaces: 1,
			outputFaceBlendshapes: true,
			outputFacialTransformationMatrixes: true,
		});
	}

	/**
	 * Open the webcam, attach it to `videoEl`, start playback, and begin the
	 * per-frame detection loop. Calls {@link FaceTracker#init} first if needed.
	 *
	 * @param {HTMLVideoElement} videoEl
	 * @returns {Promise<MediaStream>} The active camera stream.
	 */
	async start(videoEl) {
		if (!videoEl) {
			throw trackerError('runtime', 'start() requires a <video> element');
		}
		if (this._running) {
			// Already running on this element — hand back the live stream.
			if (this._video === videoEl && this._stream) return this._stream;
			// Switching elements: tear down the old loop/stream cleanly first.
			this.stop();
		}

		if (
			typeof navigator === 'undefined' ||
			!navigator.mediaDevices ||
			typeof navigator.mediaDevices.getUserMedia !== 'function'
		) {
			const err = trackerError('unsupported', 'getUserMedia is not available in this browser');
			this._emitError(err);
			throw err;
		}

		// init() already emits a typed error on failure; let it surface to the caller.
		await this.init();

		this._video = videoEl;
		this._setStatus('requesting-camera');

		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: {
					facingMode: 'user',
					width: { ideal: 640 },
					height: { ideal: 480 },
				},
				audio: false,
			});
		} catch (camErr) {
			const err = this._mapCameraError(camErr);
			this._video = null;
			this._emitError(err);
			throw err;
		}

		this._stream = stream;

		try {
			videoEl.srcObject = stream;
			videoEl.muted = true;
			videoEl.playsInline = true;
			await this._playVideo(videoEl);
		} catch (playErr) {
			// Couldn't bind/play — release the camera so we don't leak the device.
			this._releaseStream();
			this._video = null;
			const err = trackerError('runtime', 'Failed to start webcam playback', playErr);
			this._emitError(err);
			throw err;
		}

		this._running = true;
		this._lastVideoTime = -1;
		this._lastTimestamp = -1;
		this._resetSmoothing();
		this._useRvfc = typeof videoEl.requestVideoFrameCallback === 'function';
		this._setStatus('running');
		this._scheduleNext();

		return stream;
	}

	/**
	 * Play the video element, tolerating the AbortError that fires when play()
	 * is interrupted by a fast stop().
	 *
	 * @private
	 * @param {HTMLVideoElement} videoEl
	 * @returns {Promise<void>}
	 */
	async _playVideo(videoEl) {
		try {
			await videoEl.play();
		} catch (err) {
			if (err && err.name === 'AbortError') return;
			throw err;
		}
	}

	/**
	 * Stop the detection loop and release the camera. Safe to call repeatedly and
	 * when never started. Leaves the FaceLandmarker alive so start() can resume;
	 * use {@link FaceTracker#dispose} to free it.
	 */
	stop() {
		const wasActive = this._running || !!this._stream || !!this._video;

		this._running = false;
		this._cancelLoop();
		this._releaseStream();

		if (this._video) {
			try {
				this._video.srcObject = null;
			} catch {
				/* element may already be detached from the DOM */
			}
			this._video = null;
		}

		this._lastVideoTime = -1;
		this._lastTimestamp = -1;
		this._resetSmoothing();

		if (wasActive) this._setStatus('stopped');
	}

	/**
	 * Fully release MediaPipe resources. After dispose() you must call init()
	 * again before start(). Calls stop() first.
	 */
	dispose() {
		this.stop();
		if (this._landmarker) {
			try {
				this._landmarker.close();
			} catch (err) {
				console.warn('[FaceTracker] Error closing FaceLandmarker.', err);
			}
			this._landmarker = null;
		}
		this._initPromise = null;
	}

	/**
	 * Cancel any pending rAF / rVFC callback.
	 * @private
	 */
	_cancelLoop() {
		if (this._rafId) {
			cancelAnimationFrame(this._rafId);
			this._rafId = 0;
		}
		if (this._rvfcId && this._video && typeof this._video.cancelVideoFrameCallback === 'function') {
			try {
				this._video.cancelVideoFrameCallback(this._rvfcId);
			} catch {
				/* element gone; nothing to cancel */
			}
		}
		this._rvfcId = 0;
	}

	/**
	 * Stop and detach all tracks of the active stream.
	 * @private
	 */
	_releaseStream() {
		if (this._stream) {
			for (const track of this._stream.getTracks()) {
				try {
					track.stop();
				} catch {
					/* already stopped */
				}
			}
			this._stream = null;
		}
	}

	/**
	 * Schedule the next loop tick using rVFC when available, else rAF.
	 * @private
	 */
	_scheduleNext() {
		if (!this._running || !this._video) return;
		const tick = () => this._onTick();
		if (this._useRvfc && typeof this._video.requestVideoFrameCallback === 'function') {
			this._rvfcId = this._video.requestVideoFrameCallback(tick);
		} else {
			this._rafId = requestAnimationFrame(tick);
		}
	}

	/**
	 * One detection step: run MediaPipe on the current video frame (if it's new
	 * and decodable), normalize the result, and emit a FaceFrame.
	 * @private
	 */
	_onTick() {
		if (!this._running || !this._video || !this._landmarker) return;

		const video = this._video;

		try {
			// readyState >= 2 (HAVE_CURRENT_DATA) means there's a frame to read.
			if (video.readyState >= 2 && video.videoWidth > 0) {
				const now = performance.now();
				// Skip if the decoded frame hasn't advanced — feeding the same frame
				// wastes work and an unchanged timestamp makes MediaPipe throw.
				if (video.currentTime !== this._lastVideoTime) {
					this._lastVideoTime = video.currentTime;
					// Guarantee a strictly increasing timestamp for detectForVideo().
					const ts = now > this._lastTimestamp ? now : this._lastTimestamp + 1;
					this._lastTimestamp = ts;

					const result = this._landmarker.detectForVideo(video, ts);
					this._emitFrame(result, now);
				}
			}
		} catch (err) {
			// A runtime detection failure shouldn't kill the loop silently, but we
			// also don't want to spam — surface once, then keep trying next frame.
			this._emitError(trackerError('runtime', 'Face detection failed for a frame', err));
		}

		this._scheduleNext();
	}

	/**
	 * Convert a MediaPipe FaceLandmarkerResult into a smoothed FaceFrame and emit it.
	 *
	 * @private
	 * @param {import('@mediapipe/tasks-vision').FaceLandmarkerResult} result
	 * @param {number} ts
	 */
	_emitFrame(result, ts) {
		const blendList = result.faceBlendshapes && result.faceBlendshapes[0];
		const matrix = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
		const present = !!(blendList && blendList.categories && blendList.categories.length);

		if (!present) {
			if (this._wasPresent || this._status === 'running') this._setStatus('no-face');
			this._wasPresent = false;
			this._resetSmoothing();
			this.onFrame({ present: false, blendshapes: {}, head: null, ts });
			return;
		}

		if (!this._wasPresent && this._status === 'no-face') this._setStatus('running');
		this._wasPresent = true;

		const blendshapes = this._smoothBlendshapes(blendList.categories);
		const head = matrix && matrix.data ? this._smoothHead(this._decodeHead(matrix.data)) : null;

		this.onFrame({ present: true, blendshapes, head, ts });
	}

	/**
	 * Map MediaPipe blendshape categories → { arkitName: weight }, dropping the
	 * `_neutral` channel, and apply light exponential smoothing against the cache.
	 *
	 * @private
	 * @param {Array<{categoryName: string, score: number}>} categories
	 * @returns {Object<string, number>}
	 */
	_smoothBlendshapes(categories) {
		const t = 1 - this._smoothing; // blend toward the new value
		/** @type {Object<string, number>} */
		const out = {};
		for (const c of categories) {
			const name = c.categoryName;
			if (!name || name === '_neutral') continue;
			const prev = this._smoothedShapes[name];
			const value = prev === undefined ? c.score : lerp(prev, c.score, t);
			this._smoothedShapes[name] = value;
			out[name] = value;
		}
		return out;
	}

	/**
	 * Decode head pitch/yaw/roll (radians) from a 4x4 column-major transform matrix.
	 *
	 * @private
	 * @param {Float32Array|number[]} data length-16 column-major matrix
	 * @returns {{pitch:number, yaw:number, roll:number}}
	 */
	_decodeHead(data) {
		this._mat4.fromArray(data);
		this._mat4.decompose(this._pos, this._quat, this._scale);
		this._euler.setFromQuaternion(this._quat, 'YXZ');
		return { pitch: this._euler.x, yaw: this._euler.y, roll: this._euler.z };
	}

	/**
	 * Smooth head angles against the cache.
	 *
	 * @private
	 * @param {{pitch:number, yaw:number, roll:number}} head
	 * @returns {{pitch:number, yaw:number, roll:number}}
	 */
	_smoothHead(head) {
		const t = 1 - this._smoothing;
		if (!this._smoothedHead) {
			this._smoothedHead = { ...head };
		} else {
			this._smoothedHead = {
				pitch: lerp(this._smoothedHead.pitch, head.pitch, t),
				yaw: lerp(this._smoothedHead.yaw, head.yaw, t),
				roll: lerp(this._smoothedHead.roll, head.roll, t),
			};
		}
		return { ...this._smoothedHead };
	}

	/**
	 * Clear smoothing caches so a fresh session / re-acquired face starts clean.
	 * @private
	 */
	_resetSmoothing() {
		this._smoothedShapes = {};
		this._smoothedHead = null;
	}

	/**
	 * Translate a getUserMedia rejection into a typed FaceTracker error.
	 *
	 * @private
	 * @param {unknown} camErr
	 * @returns {Error & { code: string }}
	 */
	_mapCameraError(camErr) {
		const name = camErr && /** @type {{ name?: string }} */ (camErr).name;
		switch (name) {
			case 'NotAllowedError':
			case 'SecurityError':
			case 'PermissionDeniedError':
				return trackerError('camera-denied', 'Camera permission was denied', camErr);
			case 'NotFoundError':
			case 'DevicesNotFoundError':
			case 'OverconstrainedError':
				return trackerError('camera-missing', 'No suitable camera was found', camErr);
			default:
				return trackerError('runtime', 'Could not access the camera', camErr);
		}
	}

	/**
	 * Emit a status transition (deduped) through onStatus.
	 *
	 * @private
	 * @param {'idle'|'loading-model'|'requesting-camera'|'running'|'stopped'|'no-face'} status
	 */
	_setStatus(status) {
		if (this._status === status) return;
		this._status = status;
		try {
			this.onStatus(status);
		} catch (err) {
			console.warn('[FaceTracker] onStatus handler threw.', err);
		}
	}

	/**
	 * Emit a typed error through onError, guarding against a throwing handler.
	 *
	 * @private
	 * @param {Error & { code: string }} err
	 */
	_emitError(err) {
		try {
			this.onError(err);
		} catch (handlerErr) {
			console.warn('[FaceTracker] onError handler threw.', handlerErr);
		}
	}
}
