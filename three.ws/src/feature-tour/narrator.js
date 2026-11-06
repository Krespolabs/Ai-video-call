// narrator.js — speak a stop's narration through the platform's free TTS lane
// (/api/tts/speak: NVIDIA Magpie → OpenAI backstop) and resolve when the audio
// finishes, so the director can advance in time with the voice. When muted or
// when TTS is unavailable, it falls back to a timed silence sized to the text
// so captions still pace correctly. Every call is cancelable (skip / pause /
// exit) via a monotonic token — a stale fetch or audio that returns after a
// cancel is ignored.
//
// Mobile / iOS audio:
//   Safari (and most touch browsers) refuse audio.play() unless it happens
//   inside a user gesture, and that permission does NOT survive a navigation —
//   which the cross-page tour does constantly. So instead of `new Audio()` per
//   clip (each one a fresh, un-blessed element that iOS blocks), we keep ONE
//   persistent <audio> element and "bless" it once per page via unlock(): a
//   single silent play() driven from a real tap. Every later clip reuses that
//   blessed element, so it plays without a gesture. If a clip is blocked anyway
//   (page not yet unlocked), speak() reports it via onBlocked and paces the
//   caption on a timer instead of advancing instantly — the director re-narrates
//   the stop the moment unlock() succeeds, so nothing is missed.

const WPM = 150;

// A tiny silent MP3. Playing it during a tap blesses the audio element for all
// later programmatic play() calls on the same page (the iOS autoplay unlock).
const SILENT_MP3 =
	'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxAUACAAGkABFCAAggAAAAaAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

export class Narrator {
	constructor() {
		this.audio = null;
		this.onBlocked = null; // director hook: fired when a clip is blocked by autoplay policy
		this._token = 0;
		this._sleepTimer = 0;
		this._sleepResolve = null;
		this._finishCurrent = null;
		this._el = null; // the single, persistent (unlockable) audio element
		this._unlocked = false;
		this._blocked = false;
		this._coarse =
			typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false;
	}

	estimateMs(text, speed = 1) {
		const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
		const base = Math.max(1600, (words / WPM) * 60000 + 600);
		return base / clampSpeed(speed);
	}

	// The one audio element every clip plays through. Created lazily so SSR/import
	// stays side-effect free; reused forever so the iOS unlock survives between
	// clips on the same page.
	_element() {
		if (this._el) return this._el;
		const el = new Audio();
		el.preload = 'auto';
		el.setAttribute('playsinline', ''); // never go fullscreen on iOS
		this._el = el;
		return el;
	}

	// True when this device gates audio behind a gesture and we haven't been
	// blessed on this page yet — the director uses it to show a "tap for voice"
	// affordance instead of letting the first clip silently fail.
	needsUnlock() {
		return this._coarse && !this._unlocked;
	}

	get blocked() {
		return this._blocked;
	}

	// Bless the audio element from inside a user gesture by playing a silent clip.
	// Idempotent and safe to call on every tap — once unlocked it short-circuits.
	// Returns true if audio is now usable.
	async unlock() {
		if (this._unlocked) return true;
		const el = this._element();
		const wasSrc = el.src;
		try {
			el.src = SILENT_MP3;
			el.playbackRate = 1;
			await el.play();
			el.pause();
			try {
				el.currentTime = 0;
			} catch {
				/* some engines reject seeking a data URI — harmless */
			}
			this._unlocked = true;
			this._blocked = false;
			return true;
		} catch {
			// Restore whatever was queued; the gesture wasn't enough (rare).
			if (wasSrc && wasSrc !== SILENT_MP3) el.src = wasSrc;
			return false;
		}
	}

	// Speak `text`; resolves when playback (or the timed fallback) completes.
	async speak(text, { muted = false, voice = 'nova', speed = 1 } = {}) {
		this.cancel();
		const token = ++this._token;
		const rate = clampSpeed(speed);
		const clean = String(text || '').trim();
		if (!clean) return;
		if (muted) {
			await this._sleep(this.estimateMs(clean, rate), token);
			return;
		}

		let url = null;
		try {
			const res = await fetch('/api/tts/speak', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: clean.slice(0, 4096), voice, speed: rate, format: 'mp3' }),
			});
			if (token !== this._token) return; // canceled while fetching
			if (!res.ok) throw new Error(`tts ${res.status}`);
			const blob = await res.blob();
			if (token !== this._token) return;
			url = URL.createObjectURL(blob);
			const audio = this._element();
			audio.src = url;
			// The server renders the OpenAI lane at `speed`, but the free Magpie
			// lane ignores it — so also nudge playbackRate as a client-side backstop
			// that works on whichever lane answered. (1× leaves audio untouched.)
			audio.playbackRate = rate;
			this.audio = audio;
			const outcome = await new Promise((resolve) => {
				let done = false;
				const finish = (state) => {
					if (done) return;
					done = true;
					audio.removeEventListener('ended', onEnded);
					audio.removeEventListener('error', onError);
					resolve(state);
				};
				const onEnded = () => finish('ended');
				// A media error (corrupt/expired blob, decode failure) must NOT be treated
				// like a clean 'ended' — that resolves instantly and races the tour past this
				// stop with no audio AND no reading time. Pace it like an autoplay-blocked clip.
				const onError = () => finish('error');
				this._finishCurrent = () => finish('ended');
				audio.addEventListener('ended', onEnded);
				audio.addEventListener('error', onError);
				audio.play().then(
					() => {
						this._blocked = false;
					},
					(err) => {
						// Autoplay policy (no gesture on this page yet). Surface it so the
						// director can prompt for a tap, and pace the caption on a timer
						// instead of resolving instantly (which would race-advance the tour).
						if (err && err.name === 'NotAllowedError') {
							this._blocked = true;
							try {
								this.onBlocked?.();
							} catch {
								/* hook must never break narration */
							}
							finish('blocked');
						} else {
							// play() rejected for some other reason — pace, don't race.
							finish('error');
						}
					},
				);
			});
			if ((outcome === 'blocked' || outcome === 'error') && token === this._token) {
				await this._sleep(this.estimateMs(clean, rate), token);
			}
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

	// Stop any in-flight speech/sleep and invalidate pending callbacks. Keeps the
	// persistent (blessed) element alive so the iOS unlock survives the next clip.
	cancel() {
		this._token++;
		clearTimeout(this._sleepTimer);
		this._sleepTimer = 0;
		if (this._sleepResolve) {
			this._sleepResolve();
			this._sleepResolve = null;
		}
		try {
			this._el?.pause();
		} catch {
			/* ignore */
		}
		if (this._finishCurrent) this._finishCurrent();
		this._finishCurrent = null;
		this.audio = null;
	}

	dispose() {
		this.cancel();
		try {
			if (this._el) {
				this._el.pause();
				this._el.removeAttribute('src');
				this._el.load();
			}
		} catch {
			/* ignore */
		}
		this._el = null;
		this._unlocked = false;
	}
}

function clampSpeed(s) {
	const n = Number(s);
	if (!Number.isFinite(n)) return 1;
	return Math.min(2, Math.max(0.5, n));
}
