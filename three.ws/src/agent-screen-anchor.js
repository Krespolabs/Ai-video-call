// agent-screen-anchor.js — Newsroom Anchor playback for /agent-screen.
//
// When the agent pushes a type:'analysis' frame (a bulletin headline), this
// module slides up a broadcast lower-third, fetches the spoken script from
// /api/agent/anchor-script, synthesizes real speech, and lip-syncs the Avatar
// Cam head to it:
//
//   • Lipsync, best path: POST /api/a2f { text } returns the spoken audio AND a
//     per-frame ARKit blendshape track. The A2FPlayer drives the avatar's morph
//     targets frame-by-frame against the audio's currentTime.
//   • Fallback, no ARKit morphs (or A2F unconfigured): play TTS audio and bob
//     the jaw/mouth from the audio's real RMS amplitude — never a frozen face.
//   • Fallback, no audio at all: the lower-third still shows, flagged "audio
//     unavailable", so the bulletin is readable.
//
// Audio is muted by default (autoplay policy + the live wall), with a one-tap
// unmute. Nothing is synthesized while muted, so a muted viewer costs no TTS.

import { A2FPlayer } from './voice/a2f-player.js';
import { AvatarMouthTarget } from './voice/avatar-morph-target.js';

const ANCHOR_VOICE = 'nova';
const LS_MUTE_KEY = 'asc_anchor_muted';

// One shared AudioContext for the RMS analyser path — browsers cap live contexts.
let _audioCtx = null;
function audioContext() {
	if (!_audioCtx) {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (Ctx) _audioCtx = new Ctx();
	}
	return _audioCtx;
}

function b64ToBlob(base64, contentType) {
	const bytes = atob(base64);
	const arr = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
	return new Blob([arr], { type: contentType || 'audio/wav' });
}

/**
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {object} opts.els  — { lowerthird, eyebrow, headline, note, muteBtn, unmute }
 * @param {() => any} opts.getAvatar — returns the current avatar root (or null)
 */
export function createNewsroomAnchor({ agentId, els, getAvatar }) {
	const a2fPlayer = new A2FPlayer();
	const mouthTarget = new AvatarMouthTarget();
	let boundAvatar = null;

	let muted = readMutePref();
	let a2fSupported = null; // null = unprobed, false = endpoint says unconfigured

	// Active utterance state.
	let audioEl = null;
	let analyser = null;
	let analyserData = null;
	let mode = 'idle'; // 'idle' | 'a2f' | 'rms'
	let lastScript = null; // remember the latest bulletin for unmute-then-speak
	let speakToken = 0; // invalidates an in-flight speak() when a newer one starts

	function readMutePref() {
		try {
			const v = localStorage.getItem(LS_MUTE_KEY);
			return v === null ? true : v === '1';
		} catch { return true; }
	}
	function writeMutePref(v) {
		try { localStorage.setItem(LS_MUTE_KEY, v ? '1' : '0'); } catch { /* quota */ }
	}

	function ensureAvatarBound() {
		const root = getAvatar?.();
		if (root && root !== boundAvatar) {
			boundAvatar = root;
			a2fPlayer.attach(root);
			mouthTarget.attach(root);
		}
		return boundAvatar;
	}

	// ── lower-third UI ────────────────────────────────────────────────────────
	function showLowerThird(headline, { skeleton = false, note = '' } = {}) {
		if (!els.lowerthird) return;
		els.lowerthird.classList.toggle('asc-lt--skeleton', skeleton);
		els.lowerthird.classList.add('asc-lt--show');
		if (els.headline) els.headline.textContent = skeleton ? '' : (headline || '');
		if (els.note) {
			els.note.textContent = note;
			els.note.style.display = note ? 'block' : 'none';
		}
		// Long headlines marquee on hover (CSS); flag when it overflows.
		if (els.headline) {
			requestAnimationFrame(() => {
				const overflow = els.headline.scrollWidth > els.headline.clientWidth + 4;
				els.lowerthird.classList.toggle('asc-lt--overflow', overflow);
			});
		}
	}

	function setMuteUi() {
		if (els.muteBtn) {
			els.muteBtn.classList.toggle('asc-muted', muted);
			els.muteBtn.setAttribute('aria-pressed', String(!muted));
			els.muteBtn.title = muted ? 'Unmute anchor — M' : 'Mute anchor — M';
			els.muteBtn.innerHTML = muted ? '🔇' : '🔊';
		}
		if (els.unmute) els.unmute.style.display = muted ? 'flex' : 'none';
	}

	// ── speech + lipsync ───────────────────────────────────────────────────────
	function stopSpeaking() {
		speakToken++;
		if (audioEl) {
			try { audioEl.pause(); } catch { /* */ }
			if (audioEl.src?.startsWith('blob:')) { try { URL.revokeObjectURL(audioEl.src); } catch { /* */ } }
			audioEl = null;
		}
		analyser = null;
		analyserData = null;
		mode = 'idle';
		a2fPlayer.reset();
		mouthTarget.setMouthShape({ open: 0 });
	}

	async function playClip(blob, { track = null } = {}) {
		const myToken = ++speakToken;
		ensureAvatarBound();

		audioEl = new Audio();
		audioEl.src = URL.createObjectURL(blob);
		audioEl.muted = false; // we only reach here when unmuted

		// Decide lipsync path. A2F track with real morph coverage wins; otherwise
		// drive the jaw/mouth from live RMS so the face never freezes.
		if (track) a2fPlayer.setTrack(track);
		if (track && a2fPlayer.hasCoverage()) {
			mode = 'a2f';
		} else {
			mode = 'rms';
			const ctx = audioContext();
			if (ctx) {
				try {
					if (ctx.state === 'suspended') await ctx.resume();
					const src = ctx.createMediaElementSource(audioEl);
					analyser = ctx.createAnalyser();
					analyser.fftSize = 1024;
					analyser.smoothingTimeConstant = 0.5;
					src.connect(analyser);
					analyser.connect(ctx.destination);
					analyserData = new Uint8Array(analyser.fftSize);
				} catch {
					analyser = null; // element route still plays sound below
				}
			}
		}

		const cleanup = () => {
			if (myToken !== speakToken) return;
			mode = 'idle';
			a2fPlayer.reset();
			mouthTarget.setMouthShape({ open: 0 });
		};
		audioEl.addEventListener('ended', cleanup, { once: true });
		audioEl.addEventListener('error', cleanup, { once: true });

		try {
			await audioEl.play();
		} catch {
			// Autoplay blocked or decode error — surface as mute so the CTA returns.
			cleanup();
			throw new Error('audio_play_failed');
		}
	}

	// Synthesize + play one read. Tries the combined A2F text path first (audio +
	// blendshapes in one call), then plain TTS + RMS, then text-only. `voice`
	// overrides the default anchor voice so a caller (e.g. the live Q&A concierge)
	// can speak in the agent's own configured voice. Returns true once audio
	// playback has started, false when muted or every audio lane failed — the
	// caller uses this to decide whether to show a "spoken aloud" affordance.
	async function speak(text, { voice = ANCHOR_VOICE } = {}) {
		if (!text || muted) return false;
		stopSpeaking();
		const myToken = speakToken;

		// Path 1: /api/a2f text → { audio, animation }
		if (a2fSupported !== false) {
			try {
				const r = await fetch('/api/a2f', {
					method: 'POST',
					credentials: 'include',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ text, voice }),
				});
				if (r.status >= 500) {
					// Provider down or misconfigured (503 unconfigured, 502 invalid
					// model/function id, 504 timeout). The lane won't recover this
					// session — stop re-hitting it and lip-sync from RMS instead.
					a2fSupported = false;
				} else if (r.ok) {
					const j = await r.json();
					if (myToken !== speakToken) return;
					if (j?.audio?.base64 && j?.animation) {
						a2fSupported = true;
						await playClip(b64ToBlob(j.audio.base64, j.audio.contentType), { track: j.animation });
						return true;
					}
				}
			} catch { /* fall through to TTS-only */ }
		}
		if (myToken !== speakToken) return false;

		// Path 2: /api/tts/speak → audio bytes, lip-synced by RMS amplitude.
		try {
			const r = await fetch('/api/tts/speak', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, voice, format: 'mp3' }),
			});
			if (!r.ok) throw new Error(`tts ${r.status}`);
			const blob = await r.blob();
			if (myToken !== speakToken) return false;
			await playClip(blob, { track: null });
			return true;
		} catch {
			// Path 3: text-only — the lower-third stays up with an honest note.
			if (myToken === speakToken && els.note) {
				els.note.textContent = 'audio unavailable';
				els.note.style.display = 'block';
			}
			return false;
		}
	}

	async function fetchScript() {
		try {
			const r = await fetch(`/api/agent/anchor-script?agentId=${encodeURIComponent(agentId)}`);
			if (!r.ok) return null;
			const j = await r.json();
			return j?.script || null;
		} catch { return null; }
	}

	// ── public surface ──────────────────────────────────────────────────────────

	// Called for every type:'analysis' frame on the stream.
	async function handleFrame(frame) {
		const headline = frame?.activity || '';
		showLowerThird(headline, { skeleton: !headline });
		const script = await fetchScript();
		lastScript = {
			headline: script?.headline || headline,
			body: script?.body || headline,
			offline: script?.offline || [],
		};
		const note = lastScript.offline.length
			? `${lastScript.offline.join(' · ')} offline`
			: '';
		showLowerThird(lastScript.headline, { note });
		if (!muted) speak(lastScript.body);
	}

	// Driven from the webcam render loop to advance lipsync.
	function tick() {
		if (mode === 'idle' || !audioEl) return;
		ensureAvatarBound();
		if (mode === 'a2f') {
			a2fPlayer.update(audioEl.currentTime || 0);
		} else if (mode === 'rms' && analyser && analyserData) {
			analyser.getByteTimeDomainData(analyserData);
			let sum = 0;
			for (let i = 0; i < analyserData.length; i++) {
				const v = (analyserData[i] - 128) / 128;
				sum += v * v;
			}
			const rms = Math.sqrt(sum / analyserData.length);
			// Map RMS (~0–0.3 for speech) to mouth-open with a touch of gain + clamp.
			const open = Math.min(1, rms * 3.2);
			mouthTarget.setMouthShape({ open });
		}
	}

	function setMuted(next, { speakNow = true } = {}) {
		muted = next;
		writeMutePref(muted);
		setMuteUi();
		if (muted) {
			stopSpeaking();
		} else if (speakNow && lastScript?.body) {
			audioContext()?.resume?.();
			speak(lastScript.body);
		}
	}

	function toggleMute() { setMuted(!muted); }

	function init() {
		setMuteUi();
		els.muteBtn?.addEventListener('click', toggleMute);
		els.unmute?.addEventListener('click', () => setMuted(false));
	}

	function destroy() {
		stopSpeaking();
		a2fPlayer.dispose();
		mouthTarget.dispose();
	}

	init();

	return {
		handleFrame, tick, toggleMute, setMuted, isMuted: () => muted, destroy,
		// Speak arbitrary text in the agent's voice (the live Q&A concierge drives
		// this with each answer). Honours the same mute pref as bulletins.
		speak,
		// True while an utterance is actively playing — lets the screen drive a
		// body "talking" gesture in time with the voice.
		isSpeaking: () => mode !== 'idle' && !!audioEl,
	};
}
