/**
 * Prompt Dictation — a reusable "speak instead of type" mic button for any
 * generation prompt textarea (Forge object/avatar prompts, Scene Studio,
 * sketch guidance, etc.). Voice → text, funneled into the SAME text prompt
 * the existing text→3D pipeline already consumes — no new generation path.
 *
 * Reuses the exact STT strategy already proven in src/voice/talk-controller.js
 * (the avatar talk loop): prefer the browser's native SpeechRecognition
 * (Chrome/Edge/Safari — zero round-trip, live interim captions), and fall back
 * to the free NVIDIA Riva lane (src/voice/mic-capture.js + POST /api/asr) for
 * browsers without it (Firefox). When NEITHER is available the mic button is
 * never rendered — no dead affordance, per platform convention.
 *
 * Privacy: nothing is written to disk or logged. The browser path streams
 * audio straight to the OS/browser recognizer per the Web Speech API and never
 * leaves the device for text recognition; the Riva fallback path streams the
 * captured WAV to /api/asr, which forwards it in-memory to NVIDIA's Riva gRPC
 * endpoint and returns only the transcript — the audio buffer is discarded
 * when the request completes (see api/asr.js) and is never written to
 * storage.
 *
 * Usage:
 *   import { mountPromptDictation } from '../voice/prompt-dictation.js';
 *   const dictation = mountPromptDictation(containerEl, textareaEl, { language: 'en-US' });
 *   // ...
 *   dictation.destroy(); // on teardown
 */

import { MicCapture } from './mic-capture.js';

let _asrProbe = null; // memoized capability probe — one network round trip per page load

function probeRivaConfigured() {
	if (_asrProbe) return _asrProbe;
	_asrProbe = fetch('/api/asr', { headers: { accept: 'application/json' } })
		.then((r) => (r.ok ? r.json() : { configured: false }))
		.then((j) => !!j?.configured)
		.catch(() => false);
	return _asrProbe;
}

/**
 * Mount a dictation mic button into `container`, wired to fill `textarea`.
 * Renders nothing (returns a no-op handle) when neither STT path is
 * available in this browser.
 *
 * @param {HTMLElement} container - where the mic button is appended
 * @param {HTMLTextAreaElement} textarea - the prompt field to dictate into
 * @param {{ language?: string, onError?: (msg:string)=>void }} [opts]
 * @returns {{ destroy(): void }}
 */
export function mountPromptDictation(container, textarea, opts = {}) {
	if (!container || !textarea) return { destroy() {} };
	const language = opts.language || 'en-US';

	const hasBrowserSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
	const canCaptureRiva = MicCapture.isSupported();
	if (!hasBrowserSR && !canCaptureRiva) return { destroy() {} };

	injectStyles();

	const wrap = document.createElement('span');
	wrap.className = 'pd-wrap';
	wrap.innerHTML = `
		<button type="button" class="pd-mic" data-pd-mic aria-pressed="false" aria-label="Dictate this prompt by speaking">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="9" y="2" width="6" height="12" rx="3"/>
				<path d="M5 10a7 7 0 0 0 14 0"/>
				<line x1="12" y1="19" x2="12" y2="22"/>
			</svg>
		</button>
		<span class="pd-status" data-pd-status aria-live="polite"></span>
	`;
	container.appendChild(wrap);

	const micBtn = wrap.querySelector('[data-pd-mic]');
	const statusEl = wrap.querySelector('[data-pd-status]');

	let state = 'idle'; // idle | listening | transcribing | error
	let recognizer = null;
	let mic = null;
	let statusTimer = null;
	let destroyed = false;

	function setState(next, message) {
		state = next;
		micBtn.dataset.state = next;
		micBtn.setAttribute('aria-pressed', String(next === 'listening'));
		clearTimeout(statusTimer);
		if (message) {
			statusEl.textContent = message;
			statusEl.dataset.tone = next === 'error' ? 'error' : 'info';
			if (next !== 'listening' && next !== 'transcribing') {
				statusTimer = setTimeout(() => {
					if (!destroyed) statusEl.textContent = '';
				}, 4000);
			}
		} else {
			statusEl.textContent = '';
		}
	}

	function insertTranscript(text) {
		const clean = text.trim();
		if (!clean) {
			setState('error', 'No speech detected — try again or type instead.');
			return;
		}
		const existing = textarea.value.trim();
		textarea.value = existing ? `${existing} ${clean}` : clean;
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		textarea.focus();
		setState('idle', 'Added to prompt.');
	}

	function startBrowser() {
		const RecCls = window.SpeechRecognition || window.webkitSpeechRecognition;
		const rec = new RecCls();
		rec.lang = language;
		rec.continuous = false;
		rec.interimResults = true;
		rec.maxAlternatives = 1;
		recognizer = rec;

		let finalText = '';
		rec.onresult = (e) => {
			let interim = '';
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const res = e.results[i];
				if (res.isFinal) finalText += res[0].transcript;
				else interim += res[0].transcript;
			}
			if (interim) setState('listening', `“${interim}”`);
		};
		rec.onerror = (e) => {
			const kind = e.error || 'unknown';
			if (kind === 'no-speech' || kind === 'aborted') return; // benign end-of-hold
			if (kind === 'not-allowed' || kind === 'permission-denied') {
				setState('error', 'Microphone access was blocked. Allow the mic, or type instead.');
			} else {
				setState('error', `Speech recognition error (${kind}). Type instead.`);
			}
		};
		rec.onend = () => {
			recognizer = null;
			const transcript = finalText.trim();
			if (!transcript) {
				if (state === 'listening') setState('idle');
				return;
			}
			insertTranscript(transcript);
		};

		try {
			rec.start();
			setState('listening', 'Listening… tap to stop.');
		} catch (err) {
			setState('error', `Could not start the microphone: ${err.message}`);
		}
	}

	function stopBrowser() {
		try {
			recognizer?.stop();
		} catch {}
	}

	async function startRiva() {
		const m = new MicCapture();
		mic = m;
		setState('listening', 'Listening… tap to stop.');
		try {
			await m.start();
			if (mic !== m) {
				m.dispose();
				return;
			} // toggled off mid-permission-prompt
		} catch (err) {
			if (mic === m) mic = null;
			m.dispose();
			const messages = {
				'permission-denied': 'Microphone access was blocked. Allow the mic, or type instead.',
				'no-mic': 'No microphone found. Type instead.',
				unsupported: 'Voice input isn’t supported in this browser. Type instead.',
			};
			setState('error', messages[err.code] || `Could not start the microphone: ${err.message}`);
			return;
		}
	}

	async function stopRiva() {
		const m = mic;
		if (!m) return;
		mic = null;
		setState('transcribing', 'Transcribing…');
		const wav = await m.stop();
		m.dispose();
		if (!wav) {
			setState('error', 'No speech detected — try again or type instead.');
			return;
		}
		try {
			const res = await fetch(`/api/asr?language=${encodeURIComponent(language)}`, {
				method: 'POST',
				headers: { 'content-type': 'audio/wav' },
				body: wav,
			});
			if (!res.ok) {
				const msg =
					res.status === 503
						? 'Speech-to-text is not available right now. Type instead.'
						: res.status === 429
							? 'Too many voice requests — give it a moment.'
							: `Transcription failed (HTTP ${res.status}).`;
				setState('error', msg);
				return;
			}
			const data = await res.json().catch(() => ({}));
			insertTranscript(typeof data.text === 'string' ? data.text : '');
		} catch {
			setState('error', 'Network error during transcription. Type instead.');
		}
	}

	// Resolve the STT path once: browser SR wins when present (zero setup,
	// live captions); Riva is the cross-browser fallback, gated on the async
	// /api/asr capability probe so we never open a mic the server can't serve.
	let ready = hasBrowserSR ? Promise.resolve(true) : probeRivaConfigured();

	micBtn.addEventListener('click', async () => {
		if (state === 'listening') {
			if (hasBrowserSR) stopBrowser();
			else await stopRiva();
			return;
		}
		if (state === 'transcribing') return;
		setState('listening', 'Starting…');
		if (hasBrowserSR) {
			startBrowser();
			return;
		}
		const configured = await ready;
		if (destroyed) return;
		if (!configured) {
			setState('error', 'Voice input isn’t available here. Type instead.');
			return;
		}
		await startRiva();
	});

	return {
		destroy() {
			destroyed = true;
			clearTimeout(statusTimer);
			try {
				recognizer?.stop();
			} catch {}
			if (mic) {
				mic.dispose();
				mic = null;
			}
			wrap.remove();
		},
	};
}

let _stylesInjected = false;
function injectStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.textContent = `
		.pd-wrap { display: inline-flex; align-items: center; gap: 8px; }
		.pd-mic {
			display: inline-flex; align-items: center; justify-content: center;
			width: 30px; height: 30px; border-radius: 999px; border: 1px solid var(--border, rgba(255,255,255,.14));
			background: rgba(255,255,255,.04); color: inherit; cursor: pointer; padding: 0;
			transition: background .15s ease, border-color .15s ease, color .15s ease;
		}
		.pd-mic svg { width: 15px; height: 15px; }
		.pd-mic:hover { background: rgba(255,255,255,.1); }
		.pd-mic:focus-visible { outline: 2px solid var(--accent, #6c8cff); outline-offset: 2px; }
		.pd-mic[data-state='listening'] {
			background: var(--danger, #ff5470); border-color: var(--danger, #ff5470); color: #fff;
			animation: pd-pulse 1.4s ease-in-out infinite;
		}
		.pd-mic[data-state='transcribing'] { background: var(--accent, #6c8cff); border-color: var(--accent, #6c8cff); color: #0b0d14; }
		.pd-mic[data-state='error'] { border-color: var(--danger, #ff5470); color: var(--danger, #ff5470); }
		@keyframes pd-pulse {
			0%, 100% { box-shadow: 0 0 0 0 rgba(255,84,112,.45); }
			50% { box-shadow: 0 0 0 6px rgba(255,84,112,0); }
		}
		.pd-status { font-size: .76rem; opacity: .72; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.pd-status[data-tone='error'] { color: var(--danger, #ff5470); opacity: 1; }
		@media (prefers-reduced-motion: reduce) {
			.pd-mic[data-state='listening'] { animation: none; }
		}
	`;
	document.head.appendChild(style);
}
