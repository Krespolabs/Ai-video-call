// Two-way voice chat for the /walk avatar.
//
// Push-to-talk → the avatar listens, thinks, and talks back out loud:
//
//   hold T / mic button ─▶ MicCapture (getUserMedia → 16 kHz WAV)
//        release ─▶ POST /api/asr           (NVIDIA Riva STT → transcript)
//                ─▶ POST /api/chat (SSE)     (persona + history → LLM reply)
//                ─▶ POST /api/tts/speak      (NVIDIA Magpie / OpenAI → audio)
//                ─▶ Audio playback + LipsyncDriver (amplitude → jaw/visemes)
//                   + the `talking` gesture from the WalkGestures layer.
//
// Every leg is a real network call — no stubs, no fake audio. The class is
// self-contained: it builds nothing it can't tear down, holds the last ten
// turns so the conversation has memory, and degrades gracefully at every
// boundary (no mic, blocked permission, empty transcript, dead TTS lane).
//
// Wiring lives in walk.js (setupVoiceChat): it hands us closures onto the
// page's speech-bubble, chat-log, talking-overlay, persona, and multiplayer
// broadcast so this module never reaches into walk.js internals directly.

import { MicCapture } from './voice/mic-capture.js';
import { LipsyncDriver, tapAudioElement } from './voice/lipsync-driver.js';
import { AvatarMouthTarget } from './voice/avatar-morph-target.js';
import { log } from './shared/log.js';

const MAX_TURNS = 10; // user+assistant pairs retained for LLM context
const MAX_RECORD_MS = 20_000; // hard cap on a single push-to-talk hold
const MIN_RECORD_MS = 250; // ignore accidental taps shorter than this
const TTS_MAX_CHARS = 600; // keep spoken replies snappy; bubble shows the rest
const SPEAK_TIMEOUT_MS = 30_000; // safety net so the talking gesture always clears

// State → user-facing microcopy. The status line under the mic button reads
// each phase so the user always knows whether to keep talking or wait.
const STATUS = {
	idle: 'Hold to talk',
	listening: 'Listening…',
	transcribing: 'Hearing you…',
	thinking: 'Thinking…',
	speaking: 'Speaking…',
};

export class WalkVoiceChat {
	/**
	 * @param {object} opts
	 * @param {HTMLElement} opts.root            Container holding the mic UI (#walk-voice).
	 * @param {() => any} opts.getAvatar         Returns the live avatar Object3D (for lipsync).
	 * @param {() => object} opts.getPersona     Returns { agentId, name, description, env }.
	 * @param {() => string} opts.getUserName    Returns the local player's display name.
	 * @param {(text:string)=>void} opts.showBubble     Float a speech bubble over the avatar.
	 * @param {(on:boolean)=>void} opts.setTalking       Toggle the looping talking gesture.
	 * @param {(name:string,text:string,opts?:object)=>void} opts.addChatLog  Append to the chat log.
	 * @param {(text:string)=>void} [opts.broadcast]     Mirror the avatar's line to other players.
	 */
	constructor(opts = {}) {
		this.root = opts.root || null;
		this.getAvatar = opts.getAvatar || (() => null);
		this.getPersona = opts.getPersona || (() => ({}));
		this.getUserName = opts.getUserName || (() => 'you');
		this.showBubble = opts.showBubble || (() => {});
		this.setTalking = opts.setTalking || (() => {});
		this.addChatLog = opts.addChatLog || (() => {});
		this.broadcast = opts.broadcast || (() => {});

		this.voice = 'nova';
		this.history = []; // [{ role:'user'|'assistant', content }] — capped to MAX_TURNS pairs
		this.state = 'idle';
		this._busy = false; // a turn is mid-flight (STT→LLM→TTS)
		this._recordStart = 0;
		this._recordCap = null;
		this._mic = null;
		this._lipCtx = null; // shared AudioContext for TTS playback + lipsync analyser
		this._mouthTarget = null;
		this._mouthAttached = null; // last avatar we bound the mouth target to
		this._levelRaf = 0;
		this._levels = new Array(28).fill(0); // rolling waveform history
		this._destroyed = false;

		// DOM handles (resolved in mount()).
		this.btn = null;
		this.statusEl = null;
		this.waveCanvas = null;
		this.waveCtx = null;
		this.errorEl = null;
	}

	/** Build behavior over the markup in #walk-voice. No-op if it's absent. */
	mount() {
		if (!this.root) return;
		this.btn = this.root.querySelector('[data-voice-mic]');
		this.statusEl = this.root.querySelector('[data-voice-status]');
		this.waveCanvas = this.root.querySelector('[data-voice-wave]');
		this.errorEl = this.root.querySelector('[data-voice-error]');
		if (this.waveCanvas) this.waveCtx = this.waveCanvas.getContext('2d');

		if (!MicCapture.isSupported()) {
			// No mic path at all (insecure origin / unsupported browser). Surface it
			// once and disable the control rather than letting a press throw.
			this._showError(
				'Voice chat needs a microphone on a secure (https) connection. Use the chat box instead.',
				false,
			);
			if (this.btn) {
				this.btn.disabled = true;
				this.btn.setAttribute('aria-disabled', 'true');
			}
			return;
		}

		this._setState('idle');
		this._bindButton();
	}

	// ── Push-to-talk plumbing ────────────────────────────────────────────────

	_bindButton() {
		if (!this.btn) return;
		// Pointer events cover mouse, touch, and pen with one path. We capture the
		// pointer so a release outside the button still ends the recording.
		const down = (e) => {
			if (this.btn.disabled) return;
			e.preventDefault();
			try {
				this.btn.setPointerCapture?.(e.pointerId);
			} catch {
				/* capture is best-effort */
			}
			this.startListening();
		};
		const up = (e) => {
			e.preventDefault();
			this.stopListening();
		};
		this.btn.addEventListener('pointerdown', down);
		this.btn.addEventListener('pointerup', up);
		this.btn.addEventListener('pointercancel', up);
		// Holding space/enter on a focused <button> would also fire click — swallow
		// it so keyboard users get push-to-talk via the global T key instead.
		this.btn.addEventListener('click', (e) => e.preventDefault());
	}

	/** Begin capturing. Idempotent; ignored while a turn is still processing. */
	async startListening() {
		if (this._destroyed || this._busy || this.state === 'listening') return;
		this._clearError();

		// Create + resume the playback context now, inside the user gesture, so the
		// reply can play later even though that happens after async STT/LLM.
		this._ensureAudioContext();

		this._mic = new MicCapture();
		try {
			await this._mic.start();
		} catch (err) {
			this._mic?.dispose();
			this._mic = null;
			this._handleMicError(err);
			return;
		}
		if (this._destroyed) {
			this._mic.dispose();
			this._mic = null;
			return;
		}

		this._recordStart = performance.now();
		this._setState('listening');
		this._startLevelMeter();
		// Auto-release on the hard cap so a stuck key never records forever.
		this._recordCap = setTimeout(() => this.stopListening(), MAX_RECORD_MS);
	}

	/** Stop capturing and run the turn. Safe to call when not recording. */
	async stopListening() {
		if (this.state !== 'listening' || !this._mic) return;
		clearTimeout(this._recordCap);
		this._recordCap = null;
		this._stopLevelMeter();

		const heldMs = performance.now() - this._recordStart;
		let wav = null;
		try {
			wav = await this._mic.stop();
		} catch (err) {
			log.warn('[voice-chat] mic stop failed:', err?.message);
		}
		this._mic.dispose();
		this._mic = null;

		if (heldMs < MIN_RECORD_MS || !wav || wav.size < 1024) {
			// A tap, not a phrase — quietly return to idle.
			this._setState('idle');
			return;
		}

		this._runTurn(wav).catch((err) => {
			log.warn('[voice-chat] turn failed:', err?.message);
			this._busy = false;
			this.setTalking(false);
			this._showError(err?.message || 'Something went wrong. Try again.', true);
			this._setState('idle');
		});
	}

	// ── The turn: STT → LLM → TTS ────────────────────────────────────────────

	async _runTurn(wav) {
		this._busy = true;
		this._setState('transcribing');

		const transcript = await this._transcribe(wav);
		if (this._destroyed) return;
		if (!transcript) {
			this._busy = false;
			this._showError("Didn't catch that — hold the button and speak again.", true);
			this._setState('idle');
			return;
		}

		// Echo what we heard into the chat log so the conversation has a transcript.
		this.addChatLog(this.getUserName() || 'you', transcript);
		this._pushHistory('user', transcript);

		this._setState('thinking');
		const reply = await this._chat(transcript);
		if (this._destroyed) return;
		if (!reply) {
			this._busy = false;
			this._showError('No reply came back. Try again.', true);
			this._setState('idle');
			return;
		}
		this._pushHistory('assistant', reply);

		await this.speak(reply);
		this._busy = false;
		if (this.state !== 'listening') this._setState('idle');
	}

	/** POST the captured WAV to the Riva ASR lane; returns trimmed transcript. */
	async _transcribe(wav) {
		const res = await fetch('/api/asr?language=en-US', {
			method: 'POST',
			headers: { 'content-type': 'audio/wav' },
			body: wav,
		});
		if (!res.ok) {
			if (res.status === 503) throw new Error('Speech-to-text is not available right now.');
			if (res.status === 429) throw new Error('Too many voice messages — give it a moment.');
			throw new Error(`Transcription failed (HTTP ${res.status}).`);
		}
		const data = await res.json().catch(() => ({}));
		return typeof data.text === 'string' ? data.text.trim() : '';
	}

	/**
	 * Stream a reply from /api/chat using the avatar's persona + conversation
	 * history. Reads the SSE body, accumulates chunks, and returns the final
	 * `reply` (or the accumulated text if the stream ends without a done event).
	 */
	async _chat(message) {
		const persona = this.getPersona() || {};
		const body = {
			message,
			history: this.history.slice(0, -1).slice(-MAX_TURNS * 2), // exclude the just-pushed turn
			context: persona.env ? { currentEnvironment: persona.env } : {},
		};
		if (persona.agentId) body.agentId = persona.agentId;
		else {
			const sys = buildPersonaPrompt(persona);
			if (sys) body.system_prompt = sys;
		}

		const res = await fetch('/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok || !res.body) {
			if (res.status === 429) throw new Error('Too many messages — give it a moment.');
			throw new Error(`Chat failed (HTTP ${res.status}).`);
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let accumulated = '';
		let finalReply = '';
		let streamError = '';

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE frames are separated by a blank line.
			let sep;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const line = frame.split('\n').find((l) => l.startsWith('data:'));
				if (!line) continue;
				const payload = line.slice(5).trim();
				if (!payload) continue;
				let evt;
				try {
					evt = JSON.parse(payload);
				} catch {
					continue;
				}
				if (evt.type === 'chunk' && typeof evt.text === 'string') {
					accumulated += evt.text;
				} else if (evt.type === 'done') {
					finalReply = (evt.reply || accumulated || '').trim();
				} else if (evt.type === 'error') {
					streamError = evt.message || 'stream error';
				}
			}
		}

		if (streamError && !finalReply && !accumulated) throw new Error(streamError);
		return (finalReply || accumulated).trim();
	}

	/**
	 * Speak a line: bubble + chat log + talking gesture + real TTS with
	 * audio-driven lipsync. Public so walk.say() can drive it directly
	 * (the contract from the speech task: walk.say(text, { voice, gesture })).
	 *
	 * @param {string} text
	 * @param {{voice?:boolean, gesture?:string|null}} [opts]
	 */
	async speak(text, opts = {}) {
		const clean = String(text || '').trim();
		if (!clean) return;
		const useVoice = opts.voice !== false;
		const useGesture = opts.gesture !== null;

		const persona = this.getPersona() || {};
		this.showBubble(clean);
		this.addChatLog(persona.name || 'Avatar', clean, { self: true });
		this.broadcast(clean);
		if (useGesture) this.setTalking(true);
		this._setState('speaking');

		let spoke = false;
		if (useVoice) {
			try {
				await this._speakAloud(clean);
				spoke = true;
			} catch (err) {
				log.warn('[voice-chat] tts failed:', err?.message);
			}
		}
		// No audio (TTS down or muted)? Hold the bubble + gesture for a read-length
		// beat so the avatar still reacts — never a fake progress bar, just timing.
		if (!spoke) await wait(Math.min(6000, Math.max(1500, clean.length * 45)));

		if (useGesture) this.setTalking(false);
	}

	/** Fetch TTS audio and play it through the lipsync graph. */
	async _speakAloud(text) {
		const res = await fetch('/api/tts/speak', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: text.slice(0, TTS_MAX_CHARS), voice: this.voice, format: 'mp3' }),
		});
		if (!res.ok) throw new Error(`TTS failed (HTTP ${res.status})`);
		const blob = await res.blob();
		if (!blob || blob.size === 0) throw new Error('TTS returned no audio');
		const url = URL.createObjectURL(blob);
		try {
			await this._playWithLipsync(url);
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	/**
	 * Play a same-origin audio URL. When the rig can show mouth motion we route
	 * playback through an AnalyserNode and drive { open, wide, round } onto its
	 * morphs / jaw bone; otherwise we just play to the default output.
	 */
	async _playWithLipsync(url) {
		const ctx = this._ensureAudioContext();
		const audio = new Audio();
		audio.src = url;
		audio.crossOrigin = 'anonymous';

		this._ensureMouthTarget();
		const canLipsync = ctx && this._mouthTarget?.hasAnyMouthDriver();
		let lip = null;
		let tap = null;

		try {
			if (canLipsync) {
				tap = tapAudioElement(audio, ctx);
				lip = new LipsyncDriver({ analyser: tap.analyser, target: this._mouthTarget });
			}
			await audio.play();
			lip?.start();
		} catch {
			// MediaElementSource / autoplay can fail; fall back to a bare element so
			// the user still hears the reply.
			tap?.disconnect();
			tap = null;
			lip = null;
			try {
				await audio.play();
			} catch (playErr) {
				throw new Error(playErr?.message || 'audio playback blocked', { cause: playErr });
			}
		}

		await new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(safety);
				resolve();
			};
			const safety = setTimeout(finish, SPEAK_TIMEOUT_MS);
			audio.onended = finish;
			audio.onerror = finish;
		});

		lip?.stop();
		tap?.disconnect();
	}

	// ── Audio / lipsync helpers ──────────────────────────────────────────────

	_ensureAudioContext() {
		if (this._lipCtx) {
			if (this._lipCtx.state === 'suspended') this._lipCtx.resume().catch(() => {});
			return this._lipCtx;
		}
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		try {
			this._lipCtx = new AC();
			if (this._lipCtx.state === 'suspended') this._lipCtx.resume().catch(() => {});
		} catch {
			this._lipCtx = null;
		}
		return this._lipCtx;
	}

	// Bind the mouth target to the current avatar, rebinding after a GLB swap.
	_ensureMouthTarget() {
		const av = this.getAvatar();
		if (!av) return;
		if (!this._mouthTarget) this._mouthTarget = new AvatarMouthTarget();
		if (this._mouthAttached !== av) {
			this._mouthTarget.attach(av);
			this._mouthAttached = av;
		}
	}

	// ── Live mic level meter (waveform) ──────────────────────────────────────

	_startLevelMeter() {
		this._levels.fill(0);
		const draw = () => {
			if (this.state !== 'listening') return;
			const level = this._mic ? this._mic.getLevel() : 0;
			this._levels.push(level);
			this._levels.shift();
			this._renderWave();
			this._levelRaf = requestAnimationFrame(draw);
		};
		this._levelRaf = requestAnimationFrame(draw);
	}

	_stopLevelMeter() {
		if (this._levelRaf) cancelAnimationFrame(this._levelRaf);
		this._levelRaf = 0;
		this._levels.fill(0);
		this._renderWave();
	}

	_renderWave() {
		const c = this.waveCanvas;
		const ctx = this.waveCtx;
		if (!c || !ctx) return;
		// Match the backing store to the displayed size (DPR-aware) once it's laid out.
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const w = c.clientWidth || 120;
		const h = c.clientHeight || 28;
		if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
			c.width = Math.round(w * dpr);
			c.height = Math.round(h * dpr);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const n = this._levels.length;
		const gap = 2;
		const barW = Math.max(1.5, (w - gap * (n - 1)) / n);
		const mid = h / 2;
		ctx.fillStyle = '#fafafa';
		for (let i = 0; i < n; i++) {
			const lvl = this._levels[i];
			const bh = Math.max(2, lvl * (h - 2));
			const x = i * (barW + gap);
			const r = Math.min(barW / 2, 2);
			roundBar(ctx, x, mid - bh / 2, barW, bh, r);
		}
	}

	// ── State + error surface ────────────────────────────────────────────────

	_setState(state) {
		this.state = state;
		if (this.root) this.root.dataset.state = state;
		if (this.btn) {
			const recording = state === 'listening';
			this.btn.classList.toggle('is-recording', recording);
			const busy = state === 'transcribing' || state === 'thinking' || state === 'speaking';
			this.btn.classList.toggle('is-busy', busy);
			this.btn.setAttribute('aria-pressed', recording ? 'true' : 'false');
		}
		if (this.statusEl) this.statusEl.textContent = STATUS[state] || STATUS.idle;
	}

	_handleMicError(err) {
		const code = err?.code || '';
		if (code === 'permission-denied') {
			this._showError(
				'Microphone blocked. Click the camera/mic icon in your address bar and choose Allow, then hold to talk again.',
				true,
			);
		} else if (code === 'no-mic') {
			this._showError('No microphone found. Plug one in, or use the chat box.', false);
		} else if (code === 'unsupported') {
			this._showError('Voice chat needs a secure (https) connection. Use the chat box instead.', false);
		} else {
			this._showError(err?.message || 'Could not start the microphone.', true);
		}
		this._setState('idle');
	}

	_showError(message, retryable) {
		if (!this.errorEl) {
			// Last resort if markup is missing — never swallow the failure silently.
			log.warn('[voice-chat]', message);
			return;
		}
		this.errorEl.innerHTML = '';
		const msg = document.createElement('span');
		msg.textContent = message;
		this.errorEl.appendChild(msg);
		if (retryable) {
			const retry = document.createElement('button');
			retry.type = 'button';
			retry.className = 'walk-voice-retry';
			retry.textContent = 'Try again';
			retry.addEventListener('click', () => {
				this._clearError();
				this.startListening();
			});
			this.errorEl.appendChild(retry);
		}
		this.errorEl.hidden = false;
	}

	_clearError() {
		if (this.errorEl) {
			this.errorEl.hidden = true;
			this.errorEl.innerHTML = '';
		}
	}

	// ── Conversation memory ──────────────────────────────────────────────────

	_pushHistory(role, content) {
		this.history.push({ role, content });
		// Keep the last MAX_TURNS exchanges (×2 messages).
		const max = MAX_TURNS * 2;
		if (this.history.length > max) this.history = this.history.slice(-max);
	}

	clearHistory() {
		this.history = [];
	}

	destroy() {
		this._destroyed = true;
		clearTimeout(this._recordCap);
		this._stopLevelMeter();
		try {
			this._mic?.dispose();
		} catch {
			/* already gone */
		}
		this._mic = null;
		this._mouthTarget?.dispose?.();
		this._mouthTarget = null;
		if (this._lipCtx && this._lipCtx.state !== 'closed') this._lipCtx.close().catch(() => {});
		this._lipCtx = null;
	}
}

// Build a system prompt for avatars that have no linked agent identity, so even
// a plain GLB answers in character instead of as a generic assistant.
export function buildPersonaPrompt(persona) {
	const name = (persona?.name || '').trim();
	const desc = (persona?.description || '').trim();
	if (!name && !desc) {
		return (
			'You are a friendly, expressive 3D avatar walking around a virtual world on three.ws, ' +
			'talking with a visitor by voice. Keep replies warm, in-character, and short — one or ' +
			'two sentences, spoken aloud, no markdown or lists.'
		);
	}
	let p = `You are ${name || 'an avatar'}, a 3D character a visitor is talking to by voice in a virtual world on three.ws.`;
	if (desc) p += ` Here is who you are: ${desc}.`;
	p +=
		' Stay fully in character. Keep replies warm and short — one or two spoken sentences, ' +
		'no markdown, no lists, no stage directions.';
	return p;
}

function roundBar(ctx, x, y, w, h, r) {
	const rad = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rad, y);
	ctx.arcTo(x + w, y, x + w, y + h, rad);
	ctx.arcTo(x + w, y + h, x, y + h, rad);
	ctx.arcTo(x, y + h, x, y, rad);
	ctx.arcTo(x, y, x + w, y, rad);
	ctx.closePath();
	ctx.fill();
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
