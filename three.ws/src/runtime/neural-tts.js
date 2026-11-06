// Neural TTS lane — free, in-browser, neural-quality speech with real phoneme
// timestamps. Wraps met4citizen/HeadTTS (MIT), which runs the Kokoro 82M ONNX
// model on WebGPU (with a WASM fallback) entirely client-side: no API key, no
// per-call cost, no audio leaving the device. Unlike the browser SpeechSynthesis
// lane it returns Oculus viseme timings, so lip-sync is locked to the actual
// audio instead of a text heuristic; unlike the ElevenLabs lane it costs nothing.
//
// HeadTTS and the model weights are loaded lazily from a CDN on first speak, so
// the main bundle stays small and avatars that never use this voice pay nothing.
// First use downloads the model (~tens of MB) — surface `onProgress` in the UI.
//
// Implements the same provider contract as BrowserTTS / ElevenLabsTTS in
// speech.js: speak(), cancel(), `speaking`, onStart/onEnd, analyserNode,
// setPositionalAudio().

import { playVisemeSequence } from './lipsync.js';
import { ACTION_TYPES } from '../agent-protocol.js';

const HEADTTS_VERSION = '1.3';
const CDN = `https://cdn.jsdelivr.net/npm/@met4citizen/headtts@${HEADTTS_VERSION}`;

// Convert one HeadTTS `audio` message's viseme arrays into the timed sequence the
// shared viseme driver consumes. Oculus IDs ('aa','E','PP',…) map 1:1 onto our
// `viseme_*` morph names. Silence ('sil') is dropped — a gap in the sequence is
// already rendered as a closed mouth.
export function headttsToSequence(data) {
	const visemes = data?.visemes;
	const vtimes = data?.vtimes;
	const vdurations = data?.vdurations;
	if (!Array.isArray(visemes) || !Array.isArray(vtimes)) return [];
	const seq = [];
	for (let i = 0; i < visemes.length; i++) {
		const id = visemes[i];
		if (!id || id === 'sil') continue;
		const startMs = Number(vtimes[i]) || 0;
		const dur = Number(vdurations?.[i]) || 80;
		seq.push({ viseme: `viseme_${id}`, startMs, endMs: startMs + dur });
	}
	return seq;
}

export class NeuralTTS {
	constructor({
		voiceId = 'af_bella',
		lang = 'en-us',
		rate = 1,
		endpoints = ['webgpu', 'wasm'],
		onProgress = null,
		moduleURL = null, // override for tests / self-hosting
	} = {}) {
		this.voiceId = voiceId;
		this.lang = lang;
		this.rate = rate;
		this.endpoints = endpoints;
		this.onProgress = onProgress;
		this.moduleURL = moduleURL;

		this._tts = null;
		this._readyPromise = null;
		this._audioCtx = null;
		this._analyserNode = null;
		this._currentSource = null;
		this._lipsync = null;
		this._speaking = false;
		this._cancelled = false;
		this._positionalAudio = null;
		// Global hooks — set by callers that manage lipsync externally (e.g. AgentAvatar).
		this.onStart = null;
		this.onEnd = null;
	}

	/** Shared AnalyserNode, so an external LipSyncAnalyser can read it (parity with ElevenLabsTTS). */
	get analyserNode() {
		return this._analyserNode;
	}

	/** @param {import('three').PositionalAudio|null} pa */
	setPositionalAudio(pa) {
		this._positionalAudio = pa;
	}

	get speaking() {
		return this._speaking;
	}

	// Lazily create the audio graph + load/connect HeadTTS. Cached after the first
	// successful call; a failed load rejects and is retried on the next speak().
	async _ensureReady() {
		if (this._tts) return this._tts;
		if (this._readyPromise) return this._readyPromise;
		this._readyPromise = (async () => {
			const AC = window.AudioContext || window.webkitAudioContext;
			if (!AC) throw new Error('NeuralTTS requires Web Audio support');
			this._audioCtx = new AC();
			this._analyserNode = this._audioCtx.createAnalyser();
			this._analyserNode.fftSize = 256;
			this._analyserNode.smoothingTimeConstant = 0.7;
			this._analyserNode.connect(this._audioCtx.destination);

			const { HeadTTS } = await import(/* @vite-ignore */ this.moduleURL || `${CDN}/+esm`);
			const tts = new HeadTTS({
				endpoints: this.endpoints,
				languages: [this.lang],
				voices: [this.voiceId],
				audioCtx: this._audioCtx,
				workerModule: `${CDN}/modules/worker-tts.mjs`,
				dictionaryURL: `${CDN}/dictionaries/`,
			});
			await tts.connect(null, this.onProgress || null);
			tts.setup({ voice: this.voiceId, language: this.lang, speed: this.rate, audioEncoding: 'wav' });
			this._tts = tts;
			return tts;
		})().catch((err) => {
			// Reset so a transient failure (offline, model fetch) can be retried.
			this._readyPromise = null;
			throw err;
		});
		return this._readyPromise;
	}

	async speak(text, { onStart, onEnd, scene } = {}) {
		this.cancel();
		if (!text) return;
		this._speaking = true;
		this._cancelled = false;

		let tts;
		try {
			tts = await this._ensureReady();
		} catch (err) {
			this._speaking = false;
			throw err;
		}
		if (this._cancelled) {
			this._speaking = false;
			return;
		}

		let messages;
		try {
			messages = await tts.synthesize({ input: String(text) });
		} catch (err) {
			this._speaking = false;
			if (err?.name === 'AbortError') return;
			throw err;
		}

		const chunks = (messages || []).filter((m) => m?.type === 'audio' && m.data);
		if (this._cancelled || !chunks.length) {
			this._speaking = false;
			this.onEnd?.();
			onEnd?.();
			return;
		}

		// Play chunks (HeadTTS splits long text into sentences) back to back; the
		// first chunk that actually starts fires onStart.
		let started = false;
		const fireStart = () => {
			if (started) return;
			started = true;
			this.onStart?.();
			onStart?.();
		};
		for (const chunk of chunks) {
			if (this._cancelled) break;
			await this._playChunk(chunk.data, scene, fireStart);
		}

		this._speaking = false;
		this._lipsync?.stop();
		this._lipsync = null;
		this.onEnd?.();
		onEnd?.();
	}

	// Play one decoded AudioBuffer through the analyser (and the spatial panner when
	// set), driving the mouth from the chunk's viseme timeline on the audio clock.
	_playChunk(data, scene, onChunkStart) {
		return new Promise((resolve) => {
			const ctx = this._audioCtx;
			const buffer = data?.audio; // AudioBuffer — HeadTTS decodes it (audioCtx was supplied)
			if (!ctx || !buffer) {
				resolve();
				return;
			}

			// Re-point the analyser's terminal each chunk: spatial panner when an
			// avatar provided PositionalAudio, otherwise straight to the speakers.
			const sink = this._positionalAudio?.panner || ctx.destination;
			try {
				this._analyserNode.disconnect();
			} catch {}
			this._analyserNode.connect(sink);

			const src = ctx.createBufferSource();
			src.buffer = buffer;
			src.connect(this._analyserNode);
			this._currentSource = src;

			const t0 = ctx.currentTime;
			const seq = headttsToSequence(data);
			let lip = null;
			if (scene && seq.length) {
				lip = playVisemeSequence(scene, seq, () => (ctx.currentTime - t0) * 1000);
				this._lipsync = lip;
			}

			src.onended = () => {
				lip?.stop();
				if (this._lipsync === lip) this._lipsync = null;
				if (this._currentSource === src) this._currentSource = null;
				resolve();
			};

			ctx.resume?.().catch(() => {});
			if (this._positionalAudio?.context?.state === 'suspended') {
				this._positionalAudio.context.resume().catch(() => {});
			}
			onChunkStart?.();
			try {
				src.start();
			} catch {
				lip?.stop();
				resolve();
			}
		});
	}

	cancel(protocol) {
		const wasSpeaking = this._speaking;
		this._cancelled = true;
		this._lipsync?.stop();
		this._lipsync = null;
		if (this._currentSource) {
			try {
				this._currentSource.onended = null;
				this._currentSource.stop();
			} catch {}
			this._currentSource = null;
		}
		this._speaking = false;
		if (wasSpeaking && protocol) {
			protocol.emit?.({ type: ACTION_TYPES.INTERRUPTED, payload: {} });
		}
	}
}
