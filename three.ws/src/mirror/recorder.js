/**
 * Recorder — real-time capture, download, and share for the Mirror page.
 *
 * The Mirror page draws a 3D avatar to a <canvas> that is driven by the user's
 * webcam in real time. This module turns that live canvas into two artifacts a
 * user can keep or post:
 *
 *   1. A short video clip   — MediaRecorder over canvas.captureStream(fps),
 *                             optionally muxing a supplied mic/voice audio
 *                             track, auto-stopping at maxDurationMs.
 *   2. A still PNG snapshot — canvas.toBlob('image/png').
 *
 * Plus the plumbing to act on those artifacts: a real browser download (object
 * URL + temporary anchor, URL revoked after) and a share-to-X intent window.
 *
 * Everything here is genuine: real MediaRecorder, real canvas.captureStream,
 * real canvas.toBlob. The only timers in this file track *actual* elapsed wall
 * time (the max-duration cutoff and the onTick UI clock) — there is no
 * simulated progress, no setTimeout-faked loading.
 *
 * State machine (surfaced through `onState`):
 *
 *   idle  ──start()──▶  recording  ──stop()/auto──▶  stopping  ──blob──▶  ready
 *     ▲                     │                                                │
 *     └──────cancel()───────┘                          next start() ─────────┘
 *
 * Usage:
 *
 *   const rec = new Recorder({ fps: 30, maxDurationMs: 15000 });
 *   rec.onState = (s) => updateButton(s);
 *   rec.onTick  = (ms) => updateTimer(ms);
 *   rec.start(canvas, { audioStream: micStream }); // micStream optional
 *   // ...later...
 *   const blob = await rec.stop();
 *   if (blob) downloadBlob(blob, suggestedFilename('three-ws-mirror', 'webm'));
 *
 *   // Still image + share:
 *   const png = await snapshotPNG(canvas);
 *   downloadBlob(png, suggestedFilename('three-ws-mirror', 'png'));
 *   shareToX({ text: 'My avatar on three.ws', url: 'https://three.ws', hashtags: ['threews'] });
 *
 * Pure module: no DOM scaffolding beyond the throwaway <a> used for download
 * and window.open for share. No CSS. ES module, named exports.
 */

// MediaRecorder mimeTypes we'll try, best-first. The first one the browser
// reports as supported wins.
const MIME_CANDIDATES = [
	'video/webm;codecs=vp9',
	'video/webm;codecs=vp8',
	'video/webm',
	'video/mp4',
];

// How often onTick fires while recording (~4x/sec).
const TICK_INTERVAL_MS = 250;

/**
 * Picks the best MediaRecorder mimeType the current browser supports.
 * @returns {string} a supported mimeType, or '' to let the browser choose.
 */
function pickMimeType() {
	if (typeof MediaRecorder === 'undefined' ||
		typeof MediaRecorder.isTypeSupported !== 'function') {
		return '';
	}
	for (const mime of MIME_CANDIDATES) {
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	}
	return '';
}

/**
 * True when this environment can actually record a canvas.
 * @returns {boolean}
 */
function detectSupport() {
	if (typeof MediaRecorder === 'undefined') return false;
	if (typeof HTMLCanvasElement === 'undefined') return false;
	if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
	return true;
}

export class Recorder {
	/**
	 * @param {{ fps?: number, maxDurationMs?: number }} [opts]
	 */
	constructor(opts = {}) {
		this.fps = Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : 30;
		this.maxDurationMs = Number.isFinite(opts.maxDurationMs) && opts.maxDurationMs > 0
			? opts.maxDurationMs
			: 30000;

		// Assignable callbacks — default to no-ops so callers can skip either.
		this.onState = () => {};
		this.onTick = () => {};

		this._state = 'idle';
		this._recorder = null;
		this._stream = null;
		this._chunks = [];
		this._mimeType = '';
		this._startedAt = 0;

		this._maxTimer = null;
		this._tickTimer = null;

		// Pending stop() promise resolver, set while a stop is in flight.
		this._stopResolve = null;
	}

	/** @returns {string} current state: 'idle'|'recording'|'stopping'|'ready' */
	get state() {
		return this._state;
	}

	/** @returns {boolean} true while actively recording. */
	get recording() {
		return this._state === 'recording';
	}

	/** @returns {boolean} whether recording is possible in this environment. */
	get supported() {
		return detectSupport();
	}

	/**
	 * Begin recording the given canvas.
	 *
	 * @param {HTMLCanvasElement} canvas
	 * @param {{ audioStream?: MediaStream }} [opts] optional mic/voice stream to mux.
	 * @throws {Error} when unsupported, given a bad canvas, or already recording.
	 */
	start(canvas, opts = {}) {
		if (!this.supported) {
			throw new Error('Recording is not supported in this browser (MediaRecorder or canvas.captureStream unavailable).');
		}
		if (!canvas || typeof canvas.captureStream !== 'function') {
			throw new Error('Recorder.start requires an HTMLCanvasElement with captureStream support.');
		}
		if (this._state === 'recording' || this._state === 'stopping') {
			throw new Error('Recorder is already running. Stop or cancel before starting again.');
		}

		// Clean any leftover state from a prior 'ready' cycle.
		this._teardownTimers();
		this._chunks = [];
		this._stopResolve = null;

		const videoStream = canvas.captureStream(this.fps);
		const videoTracks = videoStream.getVideoTracks();

		let stream = videoStream;
		const audioStream = opts.audioStream;
		if (audioStream && typeof audioStream.getAudioTracks === 'function') {
			const audioTracks = audioStream.getAudioTracks();
			if (audioTracks.length > 0) {
				stream = new MediaStream([...videoTracks, ...audioTracks]);
			}
		}

		this._mimeType = pickMimeType();
		const recorderOptions = this._mimeType ? { mimeType: this._mimeType } : undefined;

		let recorder;
		try {
			recorder = new MediaRecorder(stream, recorderOptions);
		} catch (err) {
			// Fall back to default options if the chosen mimeType was rejected.
			recorder = new MediaRecorder(stream);
			this._mimeType = '';
		}

		// Honor whatever the recorder actually committed to, when exposed.
		if (recorder.mimeType) this._mimeType = recorder.mimeType;

		recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) {
				this._chunks.push(event.data);
			}
		};
		recorder.onstop = () => this._finalize();
		recorder.onerror = () => {
			// A recorder error mid-capture: salvage whatever chunks exist by
			// finalizing rather than leaving the caller hanging.
			this._finalize();
		};

		this._stream = stream;
		this._recorder = recorder;
		this._startedAt = Date.now();

		// requestData cadence isn't required — onstop flushes a final chunk —
		// but a timeslice guarantees periodic chunks for long clips.
		recorder.start(1000);

		this._setState('recording');

		this._tickTimer = setInterval(() => {
			this.onTick(Date.now() - this._startedAt);
		}, TICK_INTERVAL_MS);

		this._maxTimer = setTimeout(() => {
			this._maxTimer = null;
			// Auto-stop at the duration cap; ignore the returned promise here,
			// any pending stop() awaiter is still resolved through _finalize.
			this.stop();
		}, this.maxDurationMs);
	}

	/**
	 * Stop recording and resolve to the assembled Blob.
	 * Safe to call when not recording — resolves null.
	 *
	 * @returns {Promise<Blob|null>}
	 */
	stop() {
		if (this._state !== 'recording') {
			return Promise.resolve(null);
		}

		this._setState('stopping');
		this._teardownTimers();

		return new Promise((resolve) => {
			this._stopResolve = resolve;
			try {
				if (this._recorder && this._recorder.state !== 'inactive') {
					this._recorder.stop();
				} else {
					this._finalize();
				}
			} catch (err) {
				// If stop() throws, still finalize so the awaiter resolves.
				this._finalize();
			}
		});
	}

	/**
	 * Discard an in-progress recording without producing a blob.
	 * Resolves any pending stop() awaiter with null and returns to 'idle'.
	 */
	cancel() {
		const wasActive = this._state === 'recording' || this._state === 'stopping';
		this._teardownTimers();

		const recorder = this._recorder;
		if (recorder) {
			recorder.ondataavailable = null;
			recorder.onstop = null;
			recorder.onerror = null;
			try {
				if (recorder.state !== 'inactive') recorder.stop();
			} catch (err) {
				// Already inactive or detached — nothing to recover.
			}
		}

		this._releaseStream();
		this._recorder = null;
		this._chunks = [];
		this._mimeType = '';

		const resolve = this._stopResolve;
		this._stopResolve = null;

		if (wasActive) this._setState('idle');
		if (resolve) resolve(null);
	}

	// --- internals ---------------------------------------------------------

	/**
	 * Assemble collected chunks into a Blob, settle pending stop(), and move to
	 * 'ready'. Idempotent: guarded so a recorder error + onstop don't double-fire.
	 */
	_finalize() {
		if (this._state !== 'stopping' && this._state !== 'recording') {
			// Already finalized or cancelled.
			return;
		}

		this._teardownTimers();

		const type = this._mimeType || 'video/webm';
		const blob = this._chunks.length > 0
			? new Blob(this._chunks, { type })
			: null;

		this._chunks = [];
		this._releaseStream();
		this._recorder = null;

		const resolve = this._stopResolve;
		this._stopResolve = null;

		this._setState('ready');
		if (resolve) resolve(blob);
	}

	/** Stop and release the captured stream's tracks. */
	_releaseStream() {
		if (this._stream) {
			for (const track of this._stream.getTracks()) {
				try {
					track.stop();
				} catch (err) {
					// Track already ended.
				}
			}
			this._stream = null;
		}
	}

	/** Clear both the max-duration cutoff and the onTick interval. */
	_teardownTimers() {
		if (this._maxTimer !== null) {
			clearTimeout(this._maxTimer);
			this._maxTimer = null;
		}
		if (this._tickTimer !== null) {
			clearInterval(this._tickTimer);
			this._tickTimer = null;
		}
	}

	/**
	 * @param {'idle'|'recording'|'stopping'|'ready'} next
	 */
	_setState(next) {
		if (this._state === next) return;
		this._state = next;
		this.onState(next);
	}
}

/**
 * Capture a still PNG of the canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>} a PNG blob.
 */
export function snapshotPNG(canvas) {
	return new Promise((resolve, reject) => {
		if (!canvas || typeof canvas.toBlob !== 'function') {
			reject(new Error('snapshotPNG requires an HTMLCanvasElement with toBlob support.'));
			return;
		}
		try {
			canvas.toBlob((blob) => {
				if (blob) {
					resolve(blob);
				} else {
					reject(new Error('Failed to encode canvas to PNG (toBlob returned null).'));
				}
			}, 'image/png');
		} catch (err) {
			// canvas.toBlob throws SecurityError on a tainted (cross-origin) canvas.
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

/**
 * Trigger a browser download of a blob via a temporary object URL + anchor.
 * The object URL is revoked after the click to avoid leaking memory.
 *
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
	if (!blob) {
		throw new Error('downloadBlob requires a Blob.');
	}
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename || 'download';
	anchor.rel = 'noopener';
	anchor.style.display = 'none';
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	// Revoke on the next tick so the navigation has committed.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Open X's tweet-intent composer in a new tab, pre-filled with the supplied copy.
 * The caller supplies all text — nothing is defaulted on their behalf.
 *
 * @param {{ text?: string, url?: string, hashtags?: string[] }} params
 * @returns {Window|null} the opened window, or null if the browser blocked it.
 */
export function shareToX({ text, url, hashtags } = {}) {
	const params = new URLSearchParams();
	if (text) params.set('text', text);
	if (url) params.set('url', url);
	if (Array.isArray(hashtags) && hashtags.length > 0) {
		// X expects bare, comma-joined tags (no leading '#').
		const tags = hashtags
			.map((tag) => String(tag).replace(/^#/, '').trim())
			.filter(Boolean);
		if (tags.length > 0) params.set('hashtags', tags.join(','));
	}
	const intentUrl = `https://twitter.com/intent/tweet?${params.toString()}`;
	return window.open(intentUrl, '_blank', 'noopener');
}

/**
 * Build a timestamped filename using local time.
 *
 * @param {string} [prefix='three-ws-mirror']
 * @param {string} [ext='webm']
 * @returns {string} e.g. "three-ws-mirror-20260619-143005.webm"
 */
export function suggestedFilename(prefix = 'three-ws-mirror', ext = 'webm') {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const cleanExt = String(ext).replace(/^\./, '');
	return `${prefix}-${date}-${time}.${cleanExt}`;
}
