// narrator.js — speak a stop's narration and resolve when the audio finishes,
// so the director can advance in time with the voice. The host supplies a TTS
// endpoint (config.ttsEndpoint) that turns { text, voice, speed, format } into
// an audio response; when no endpoint is configured, or when muted, or when the
// request fails, it falls back to a timed silence sized to the text so captions
// still pace correctly. Every call is cancelable (skip / pause / exit) via a
// monotonic token — a stale fetch or audio that returns after a cancel is
// ignored.

const WPM = 150;

export class Narrator {
	constructor(config = {}) {
		this.endpoint = config.ttsEndpoint || null;
		this.audio = null;
		this._token = 0;
		this._sleepTimer = 0;
		this._sleepResolve = null;
		this._finishCurrent = null;
	}

	estimateMs(text, speed = 1) {
		const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
		const base = Math.max(1600, (words / WPM) * 60000 + 600);
		return base / clampSpeed(speed);
	}

	// Speak `text`; resolves when playback (or the timed fallback) completes.
	async speak(text, { muted = false, voice = 'nova', speed = 1 } = {}) {
		this.cancel();
		const token = ++this._token;
		const rate = clampSpeed(speed);
		const clean = String(text || '').trim();
		if (!clean) return;
		// No endpoint or muted → keep the caption up for its reading time.
		if (!this.endpoint || muted) {
			await this._sleep(this.estimateMs(clean, rate), token);
			return;
		}

		let url = null;
		try {
			const res = await fetch(this.endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: clean.slice(0, 4096), voice, speed: rate, format: 'mp3' }),
			});
			if (token !== this._token) return; // canceled while fetching
			if (!res.ok) throw new Error(`tts ${res.status}`);
			const blob = await res.blob();
			if (token !== this._token) return;
			url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			// Some lanes render the requested `speed` server-side and some ignore it,
			// so also nudge playbackRate as a client-side backstop that works on
			// whichever lane answered. (1× leaves audio untouched.)
			audio.playbackRate = rate;
			this.audio = audio;
			await new Promise((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					resolve();
				};
				this._finishCurrent = finish;
				audio.addEventListener('ended', finish);
				audio.addEventListener('error', finish);
				audio.play().catch(finish);
			});
		} catch {
			if (token !== this._token) return;
			// TTS unavailable — keep the caption on screen for its reading time.
			await this._sleep(this.estimateMs(clean), token);
		} finally {
			if (url) URL.revokeObjectURL(url);
			if (token === this._token) {
				this.audio = null;
				this._finishCurrent = null;
			}
		}
	}

	_sleep(ms, token) {
		return new Promise((resolve) => {
			this._sleepResolve = resolve;
			this._sleepTimer = setTimeout(() => {
				if (token === this._token) resolve();
			}, ms);
		});
	}

	// Stop any in-flight speech/sleep and invalidate pending callbacks.
	cancel() {
		this._token++;
		clearTimeout(this._sleepTimer);
		this._sleepTimer = 0;
		if (this._sleepResolve) {
			this._sleepResolve();
			this._sleepResolve = null;
		}
		try {
			this.audio?.pause();
		} catch {
			/* ignore */
		}
		if (this._finishCurrent) this._finishCurrent();
		this._finishCurrent = null;
		this.audio = null;
	}

	dispose() {
		this.cancel();
	}
}

function clampSpeed(s) {
	const n = Number(s);
	if (!Number.isFinite(n)) return 1;
	return Math.min(2, Math.max(0.5, n));
}
