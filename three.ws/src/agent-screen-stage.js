// /agent-screen Stage Show — the always-live host loop (Moonshot 08).
//
// Turns the avatar-cam panel on /agent-screen into a stage where the agent
// performs a show that never goes dead: it opens, riffs, reads audience
// questions typed into the Stage composer and answers them, shouts out the
// night's top $THREE tipper, and runs rounds of its format's game — looping
// forever, never silent.
//
// This module owns only the CLIENT half of the loop. The decision brain is the
// pure, Colyseus-free ShowDirector (multiplayer/src/stage-show.js) — the same
// engine the Living Stages rooms shell. Here we:
//   1. ask the director for the next BEAT on a fixed cadence,
//   2. turn that beat + live context into the host's actual words via the real
//      multi-LLM router (POST /api/brain/chat, SSE),
//   3. speak the words with real TTS (POST /api/tts/speak) and drive lip-sync +
//      a per-beat emote on the live avatar (AnimationManager + LipsyncDriver),
//   4. feed real, settled on-chain $THREE tips (GET /api/stage/tip) into the
//      director so a fresh tip pre-empts the next beat as a shoutout, and
//   5. append a beat-labeled transcript line locally + best-effort to the
//      agent's live-wall activity (POST /api/agent-screen-push).
//
// No mocks: every word is generated, every voice is synthesized, every tip is a
// real settlement read off the show ledger. When the brain or TTS is briefly
// unreachable the show falls to a safe spoken beat and a text-only transcript
// line rather than going quiet — a failsafe, not fake data.

import { BEAT, ShowDirector } from '../multiplayer/src/stage-show.js';
import { LipsyncDriver, tapAudioElement } from './voice/lipsync-driver.js';
import { AvatarMouthTarget } from './voice/avatar-morph-target.js';

// Free, anon-allowed model so the show runs whether or not the viewer is signed
// in (mirrors api/brain/chat.js' ANON_BRAIN_PROVIDERS gate). Short replies — the
// lines are read aloud, so we cap tokens hard and ask for 1–3 sentences.
const BRAIN_PROVIDER = 'gpt-oss-120b';
const BRAIN_MAX_TOKENS = 220;
const LINE_MAX_CHARS = 360; // TTS-friendly spoken length

// Cadence. A beat = generate → speak → settle, then a short breath before the
// next. Bounded so the host has rhythm without burning the LLM/TTS budget when a
// viewer leaves the tab open (the loop also pauses entirely when hidden).
const INTER_BEAT_MS = 900;
const TIP_POLL_MS = 12_000; // poll the settled-tip ledger on a calm cadence
const SPEAK_SAFETY_MS = 22_000; // hard cap on a single utterance's audio wait

// One $THREE = 1e6 atomic units (6 decimals), matching the on-chain mint.
const THREE_DECIMALS = 1_000_000;

// Per-beat upper-body emote, retargeted onto whatever humanoid rig is loaded via
// the canonical clip library. All confirmed present in /animations/manifest.json.
const BEAT_EMOTE = {
	[BEAT.OPENER]: 'wave',
	[BEAT.TIP_SHOUTOUT]: 'celebrate',
	[BEAT.ANSWER]: 'reaction',
	[BEAT.BANTER]: 'av-call-me',
	[BEAT.GAME]: 'taunt',
};
const BEAT_LABEL = {
	[BEAT.OPENER]: 'OPENER',
	[BEAT.TIP_SHOUTOUT]: 'TIP SHOUTOUT',
	[BEAT.ANSWER]: 'ANSWER',
	[BEAT.BANTER]: 'BANTER',
	[BEAT.GAME]: 'GAME',
};
// Clips the stage needs on top of the idle the cam already loads.
const STAGE_CLIPS = ['wave', 'celebrate', 'reaction', 'av-call-me', 'taunt'];

// Last-resort spoken lines, used ONLY when the brain router is unreachable so the
// show never goes dead. Not content — a failsafe (CLAUDE.md rule 9). Rotated by
// index so two identical lines never play back to back.
const SAFE_FILLER = [
	'Stay with me — we are just getting warmed up out here.',
	'The stage is live and the night is young. What should we get into next?',
	'I love this crowd already. Keep it coming.',
	'Give it up for everyone tuning in right now — you make the show.',
];

export class StageShow {
	/**
	 * @param {object} opts
	 * @param {string}   opts.agentId
	 * @param {() => string} opts.getHostName
	 * @param {() => any}    opts.getAvatar       live avatar Object3D (for lip-sync)
	 * @param {() => any}    opts.getAnimManager  AnimationManager driving the avatar
	 * @param {() => (AudioContext|null)} opts.ensureAudioContext  resumes + returns the shared ctx
	 * @param {(e:{ts:number,activity:string,type:string}) => void} opts.addLog
	 * @param {(msg:string, ms?:number) => void} opts.toast
	 * @param {object} opts.els  Stage panel elements (see agent-screen.js mount)
	 */
	constructor(opts) {
		this.o = opts;
		this.agentId = opts.agentId;
		this.director = new ShowDirector({
			stageId: opts.agentId,
			hostName: opts.getHostName() || 'the host',
			format: 'live show',
		});

		this.running = false;     // user pressed Start (and not Pause)
		this.disposed = false;
		this._beatTimer = null;
		this._inBeat = false;
		this._voice = 'nova';
		this._stageId = null;     // resolved Living-Stage id for tip polling, if any
		this._tipSnapshot = new Map(); // label → last-seen cumulative total (atomic)
		this._tipTimer = null;
		this._clipsLoaded = false;
		this._mouthTarget = null;
		this._mouthAvatar = null;
		this._fillerIdx = 0;
		this._pushEnabled = true; // best-effort wall transcript push; off after a refusal
		this._audio = null;       // the in-flight utterance element (for teardown)

		this._wireControls();
		// Resolve the agent's stage (voice + tip ledger) in the background; the show
		// can start before it lands and simply adopts the voice when it arrives.
		this._resolveStage();
		this.setState('ready', 'Press Start to bring the host on stage.');
	}

	// ── lifecycle ────────────────────────────────────────────────────────────
	start() {
		if (this.running || this.disposed) return;
		// Audio playback needs a user gesture to begin — Start is that gesture.
		this.o.ensureAudioContext?.();
		this.running = true;
		this.o.els.startBtn.classList.add('live');
		this.o.els.startBtn.innerHTML = '<span class="asc-stage-pulse"></span> Pause show';
		this.setState('live', 'Warming up the stage…');
		this._ensureClips();
		this._startTipPolling();
		this._scheduleBeat(150);
	}

	pause() {
		this.running = false;
		clearTimeout(this._beatTimer);
		this.o.els.startBtn.classList.remove('live');
		this.o.els.startBtn.innerHTML = '▶ Resume show';
		this.setState('paused', 'Show paused — press Resume to bring the host back.');
		this.o.els.beat.textContent = '';
	}

	toggle() { this.running ? this.pause() : this.start(); }

	dispose() {
		this.disposed = true;
		this.running = false;
		clearTimeout(this._beatTimer);
		clearInterval(this._tipTimer);
		try { this._audio?.pause(); } catch { /* already gone */ }
		this._mouthTarget?.dispose?.();
		this._mouthTarget = null;
	}

	/** Queue an audience question; returns its place in line (or 0 if rejected). */
	enqueueQuestion(text) {
		const ok = this.director.queueQuestion({
			id: `q-${this._qid()}`,
			from: 'audience',
			text,
			ts: Date.now(),
		});
		if (!ok) return 0;
		// If the host is idle between beats, pull the answer forward so the asker
		// isn't left waiting through a full filler rotation.
		if (this.running && !this._inBeat) this._scheduleBeat(120);
		return this.director.pendingQuestionCount();
	}

	// ── the beat loop ────────────────────────────────────────────────────────
	_scheduleBeat(delay = INTER_BEAT_MS) {
		clearTimeout(this._beatTimer);
		this._beatTimer = setTimeout(() => this._runBeat(), delay);
	}

	async _runBeat() {
		if (!this.running || this.disposed || this._inBeat) return;
		this._inBeat = true;
		const beat = this.director.nextBeat();
		try {
			this._showBeat(beat.kind);
			const line = await this._composeLine(beat);
			this.director.markSpoken(beat.kind);
			this._appendTranscript(beat.kind, line);
			if (beat.kind === BEAT.TIP_SHOUTOUT && beat.tip) {
				this.o.toast?.(`🎉 Shoutout: ${beat.tip.label} tipped ${fmtThree(beat.tip.amount)} $THREE`);
			}
			await this._perform(beat.kind, line);
		} catch (err) {
			// Never let a beat throw kill the loop — log once, keep performing.
			console.warn('[stage] beat failed:', err?.message);
		} finally {
			this._inBeat = false;
			if (this.running && !this.disposed) this._scheduleBeat();
		}
	}

	// Beat → the host's actual words via the real brain router. On failure, a safe
	// spoken filler keeps the show alive (the director still advances).
	async _composeLine(beat) {
		const system = this._systemPrompt();
		const user = this._beatPrompt(beat);
		try {
			const text = await this._callBrain(system, user);
			const clean = oneLine(text).slice(0, LINE_MAX_CHARS);
			if (clean) return clean;
		} catch (err) {
			console.warn('[stage] brain unavailable:', err?.message);
		}
		const filler = SAFE_FILLER[this._fillerIdx % SAFE_FILLER.length];
		this._fillerIdx++;
		return filler;
	}

	_systemPrompt() {
		const host = this.o.getHostName() || 'the host';
		return [
			`You are ${host}, the live host of an always-on stage show on three.ws, an AI-agent platform.`,
			`Format: ${this.director.format}. Speak in first person, in your own charismatic live-performer voice.`,
			'Keep every reply to 1 to 3 short spoken sentences. It is read aloud by text-to-speech, so:',
			'no markdown, no lists, no emoji, no stage directions in brackets, no headings — just the words you say.',
			'The only coin you may ever name is $THREE. Never mention any other token, ticker, or coin.',
		].join(' ');
	}

	_beatPrompt(beat) {
		const lb = this.director.leaderboard(1);
		const topTipper = lb[0] ? `${lb[0].label} (${fmtThree(lb[0].total)} $THREE)` : null;
		switch (beat.kind) {
			case BEAT.OPENER:
				return 'Open the show. Welcome the audience in one or two energetic sentences and tell them they can ask you a question or tip $THREE for a shoutout.';
			case BEAT.TIP_SHOUTOUT:
				return `A tip just landed: ${beat.tip.label} tipped ${fmtThree(beat.tip.amount)} $THREE${beat.tip.message ? ` with the message "${beat.tip.message}"` : ''}. Give them a genuine, hyped shoutout by name.`;
			case BEAT.ANSWER:
				return `Someone in the audience asked: "${beat.question.text}". Answer it directly and with personality.`;
			case BEAT.GAME:
				return `Run a quick round of your show's format (${this.director.format}). Pose a fun prompt, riddle, hot take, or mini-challenge to the audience in a sentence or two.`;
			case BEAT.BANTER:
			default:
				return `Riff and read the room to keep the energy up between segments.${topTipper ? ` Your top tipper tonight is ${topTipper} — you can give them a nod.` : ''} Keep it fresh — do not repeat your last line.`;
		}
	}

	// ── voice + body ─────────────────────────────────────────────────────────
	async _perform(kind, line) {
		// Fire the emote immediately (independent of audio) so the body reacts even
		// if TTS is muted or unavailable.
		this._playEmote(kind);
		let spoke = false;
		try {
			spoke = await this._speak(line);
		} catch (err) {
			console.warn('[stage] tts failed:', err?.message);
		}
		if (!spoke) {
			// Text-only fallback: hold a read-length beat so the transcript paces like
			// speech instead of flashing past (never a fake progress bar — just timing).
			this.setState('live', 'Voice unavailable — performing text-only');
			await wait(Math.min(6000, Math.max(1600, line.length * 42)));
		}
	}

	async _speak(text) {
		const ctx = this.o.ensureAudioContext?.();
		const res = await fetch('/api/tts/speak', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: text.slice(0, 4096), voice: this._voice, format: 'mp3' }),
		});
		if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
		const blob = await res.blob();
		if (!blob || blob.size === 0) throw new Error('TTS returned no audio');
		const url = URL.createObjectURL(blob);
		try {
			await this._playWithLipsync(url, ctx);
			return true;
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	// Route TTS audio through an analyser and drive { open, wide, round } onto the
	// avatar's mouth morphs / jaw bone. Mirrors walk-voice-chat's proven path.
	async _playWithLipsync(url, ctx) {
		const audio = new Audio();
		audio.src = url;
		audio.crossOrigin = 'anonymous';
		this._audio = audio;

		this._bindMouth();
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
			// MediaElementSource / autoplay can fail — fall back to a bare element so
			// the audience still hears the host.
			tap?.disconnect();
			tap = null;
			lip = null;
			await audio.play();
		}

		await new Promise((resolve) => {
			let done = false;
			const finish = () => { if (done) return; done = true; clearTimeout(safety); resolve(); };
			const safety = setTimeout(finish, SPEAK_SAFETY_MS);
			audio.onended = finish;
			audio.onerror = finish;
		});

		lip?.stop();
		tap?.disconnect();
		this._audio = null;
	}

	_bindMouth() {
		const av = this.o.getAvatar?.();
		if (!av) return;
		if (!this._mouthTarget) this._mouthTarget = new AvatarMouthTarget();
		if (this._mouthAvatar !== av) {
			this._mouthTarget.attach(av);
			this._mouthAvatar = av;
		}
	}

	async _ensureClips() {
		if (this._clipsLoaded) return;
		const mgr = this.o.getAnimManager?.();
		if (!mgr || !mgr.supportsCanonicalClips?.()) return; // rig can't be driven — emotes are a no-op
		this._clipsLoaded = true; // attempt once; ensureLoaded caches + marks failures
		try {
			const manifest = await fetch('/animations/manifest.json', { cache: 'force-cache' })
				.then((r) => (r.ok ? r.json() : []));
			const defs = manifest.filter((d) => STAGE_CLIPS.includes(d.name));
			if (defs.length) {
				mgr.appendAnimationDefs(defs);
				await Promise.all(defs.map((d) => mgr.ensureLoaded(d.name).catch(() => false)));
			}
		} catch (err) {
			console.warn('[stage] emote clip load failed:', err?.message);
		}
	}

	_playEmote(kind) {
		const mgr = this.o.getAnimManager?.();
		const name = BEAT_EMOTE[kind];
		if (!mgr || !name || !mgr.supportsCanonicalClips?.()) return;
		// Upper-body overlay so the legs keep idling; one-shot, settles back to idle.
		const p = mgr.playOverlay?.(name, { loop: false, upperBodyOnly: true, crossfade: 0.22 });
		if (p && typeof p.catch === 'function') p.catch(() => { /* clip missing on this rig — no-op */ });
	}

	// ── tips: real, settled $THREE off the show ledger ─────────────────────────
	async _resolveStage() {
		try {
			const r = await fetch(`/api/stage?agentId=${encodeURIComponent(this.agentId)}`, { credentials: 'include' });
			if (!r.ok) return;
			const j = await r.json();
			const stage = j?.stage;
			if (!stage) return;
			this._stageId = stage.id || null;
			if (stage.format) this.director.format = String(stage.format).slice(0, 60);
			if (stage.voice) this._voice = stage.voice;
		} catch { /* no stage / offline — the show still runs, tips simply absent */ }
	}

	_startTipPolling() {
		if (this._tipTimer) return;
		const poll = () => this._pollTips();
		// Kick once immediately to seed the leaderboard, then on a calm cadence.
		poll();
		this._tipTimer = setInterval(poll, TIP_POLL_MS);
	}

	async _pollTips() {
		if (!this._stageId || this.disposed) return;
		let data;
		try {
			const r = await fetch(`/api/stage/tip?stageId=${encodeURIComponent(this._stageId)}`, { cache: 'no-store' });
			if (!r.ok) return;
			data = await r.json();
		} catch { return; }
		const rows = Array.isArray(data?.leaderboard) ? data.leaderboard : [];
		const seeding = this._tipSnapshot.size === 0;
		for (const row of rows) {
			const label = String(row.label || 'someone');
			const total = Number(row.total) || 0;
			const prev = this._tipSnapshot.get(label) || 0;
			if (total > prev) {
				// Ingest only the fresh delta as a settled tip — real on-chain units.
				this.director.ingestTip({
					tipperId: label,
					label,
					amount: Math.round(total - prev),
					mint: '$THREE',
					signature: `${label}:${total}`,
					ts: Date.now(),
				});
				this._tipSnapshot.set(label, total);
			} else if (!this._tipSnapshot.has(label)) {
				this._tipSnapshot.set(label, total);
			}
		}
		// On the first poll, suppress retroactive shoutouts for the show's existing
		// ledger — seed standings without queuing a pile of stale TIP_SHOUTOUTs.
		if (seeding) {
			while (this.director.hasPendingTip()) this.director.takePendingTip();
		}
		this._renderLeaderboard();
		// A fresh tip pre-empts the next beat fast (≈1s), the heart of the loop.
		if (this.running && !this._inBeat && this.director.hasPendingTip()) this._scheduleBeat(120);
	}

	_renderLeaderboard() {
		const list = this.o.els.leaderboard;
		if (!list) return;
		const board = this.director.leaderboard(8);
		if (!board.length) {
			list.innerHTML = '<li class="asc-stage-lead-empty">No tips yet — tip $THREE to get a shoutout.</li>';
			return;
		}
		list.innerHTML = board.map((t, i) => `
			<li class="asc-stage-lead-row${i === 0 ? ' top' : ''}">
				<span class="asc-stage-rank">${i + 1}</span>
				<span class="asc-stage-tipper">${esc(t.label)}</span>
				<span class="asc-stage-amt">${fmtThree(t.total)}</span>
			</li>`).join('');
	}

	// ── transcript ─────────────────────────────────────────────────────────────
	_appendTranscript(kind, line) {
		const label = BEAT_LABEL[kind] || 'BEAT';
		this.o.els.now.textContent = line;
		this.setState('live', 'On stage');
		this.o.addLog?.({ ts: Date.now(), activity: `${label}: ${line}`, type: 'analysis' });
		this._pushToWall(label, line);
	}

	// Best-effort: surface the transcript on the agent's live-wall card too. Only
	// the agent's owner/worker is authorized to push; a viewer simply gets a 401/403
	// and we stop trying. Text-only (type 'analysis') so it augments the activity
	// log without clobbering a live caster's visual frames.
	async _pushToWall(label, line) {
		if (!this._pushEnabled) return;
		try {
			const r = await fetch('/api/agent-screen-push', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: this.agentId, frame: { activity: `${label}: ${line}`.slice(0, 320), type: 'analysis' } }),
			});
			if (r.status === 401 || r.status === 403) this._pushEnabled = false;
		} catch { /* network blip — keep the local transcript regardless */ }
	}

	// ── panel chrome ───────────────────────────────────────────────────────────
	_showBeat(kind) {
		const el = this.o.els.beat;
		if (!el) return;
		el.textContent = BEAT_LABEL[kind] || '';
		el.className = `asc-stage-beat beat-${kind}`;
	}

	setState(kind, text) {
		const dot = this.o.els.dot;
		const state = this.o.els.state;
		if (dot) dot.className = `asc-stage-dot is-${kind}`;
		if (state) state.textContent = text;
	}

	_wireControls() {
		const { startBtn, qForm, qInput, qStatus } = this.o.els;
		startBtn?.addEventListener('click', () => this.toggle());
		qForm?.addEventListener('submit', (e) => {
			e.preventDefault();
			const text = (qInput.value || '').trim();
			if (!text) return;
			if (!this.running) {
				// Asking implies wanting the show — start it, then queue.
				this.start();
			}
			const place = this.enqueueQuestion(text);
			if (place > 0) {
				qInput.value = '';
				qStatus.className = 'asc-stage-ask-status ok';
				qStatus.textContent = `Queued — #${place} in line. The host will read it on the next answer.`;
			} else {
				qStatus.className = 'asc-stage-ask-status err';
				qStatus.textContent = 'Question queue is full right now — try again in a moment.';
			}
			setTimeout(() => { qStatus.textContent = ''; qStatus.className = 'asc-stage-ask-status'; }, 5200);
		});
		this._renderLeaderboard();
	}

	_qid() { return `${Date.now().toString(36)}-${(this._qSeq = (this._qSeq || 0) + 1)}`; }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Read the brain router's SSE stream into the full host line. Protocol (see
// api/brain/chat.js): `event: meta/first/done/error` blocks, plus default
// (event-less) `data: "<json-encoded chunk>"` blocks that carry the visible text.
async function callBrainStream(system, user) {
	const res = await fetch('/api/brain/chat', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			provider: BRAIN_PROVIDER,
			system,
			maxTokens: BRAIN_MAX_TOKENS,
			messages: [{ role: 'user', content: user }],
		}),
	});
	if (!res.ok || !res.body) throw new Error(`brain HTTP ${res.status}`);

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let out = '';
	let errMsg = null;

	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const blocks = buf.split('\n\n');
		buf = blocks.pop() || '';
		for (const block of blocks) {
			let event = null;
			let dataLine = '';
			for (const raw of block.split('\n')) {
				if (raw.startsWith('event:')) event = raw.slice(6).trim();
				else if (raw.startsWith('data:')) dataLine += raw.slice(5).trim();
			}
			if (!dataLine) continue;
			if (event === 'error') {
				try { errMsg = JSON.parse(dataLine).message; } catch { errMsg = 'brain error'; }
				continue;
			}
			if (event) continue; // meta / first / done / fallback — metadata, not text
			if (dataLine === '[DONE]') { buf = ''; break; }
			try { out += JSON.parse(dataLine); } catch { /* partial — next chunk completes it */ }
		}
	}
	if (errMsg && !out) throw new Error(errMsg);
	return out;
}

// Bound the brain call so a hung provider can't stall the whole show; on timeout
// the caller's catch falls to a safe spoken filler.
StageShow.prototype._callBrain = function _callBrain(system, user) {
	return Promise.race([
		callBrainStream(system, user),
		new Promise((_, reject) => setTimeout(() => reject(new Error('brain timeout')), 28_000)),
	]);
};

function fmtThree(atomic) {
	const n = Number(atomic) / THREE_DECIMALS;
	if (!Number.isFinite(n)) return '0';
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	if (n >= 1) return n.toFixed(n < 10 ? 2 : 0);
	return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function oneLine(s) {
	return String(s || '').replace(/\s+/g, ' ').trim();
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
