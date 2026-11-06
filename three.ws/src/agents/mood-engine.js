// Mood engine — the live emotional state of the active agent.
//
// This is the running heart that the pure model (mood-model.js) only describes.
// It owns ONE mood per active agent, moves it on real bus signals, decays it
// toward baseline on a visibility-aware tick, persists it (server + local) for
// continuity across sessions, and emits `mood:changed` so the body re-expresses
// everywhere (mood-embodiment.js, the Companion, the inspector).
//
// Invariant: mood never moves without a real signal. The decay tick only relaxes
// toward baseline — it never injects emotion. There is no `Math.random()` and no
// timer that fabricates a mood; every move is traceable to a bus event or a real
// chat message scored by the deterministic lexicon.

import { agentBus, EVENTS } from './agent-bus.js';
import { onActiveAgentChange, getActiveAgentId, peekActiveAgent } from './active-agent.js';
import { apiFetch } from '../api.js';
import { scoreSentiment } from '../social/sentiment.js';
import {
	BASELINE,
	DEFAULT_SENSITIVITY,
	clampSensitivity,
	makeState,
	moodLabel,
	moodDistance,
	applySignal,
	decay,
	signalFromSentiment,
	SIGNALS,
} from './mood-model.js';

const LS_PREFIX = 'threews:mood:';
const TICK_MS = 3000;            // decay cadence while the tab is visible
const EMIT_EPSILON = 0.015;      // re-emit when the point drifts at least this far
const PERSIST_DEBOUNCE_MS = 2500;
const SIGNAL_LOG_MAX = 24;       // recent signals kept for the inspector feed
const GESTURE_DISTANCE = 0.12;   // transition this large plays an embodiment beat

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const isoNow = () => new Date().toISOString();

class MoodEngine {
	constructor() {
		this.agentId = null;
		this.state = makeState();
		this.sensitivity = DEFAULT_SENSITIVITY;
		this._lastEmitted = { ...this.state };
		this._lastTick = now();
		this._signals = [];              // [{ source, label, valence, arousal, ts }]
		this._timer = null;
		this._persistTimer = null;
		this._pendingSignal = null;      // last signal awaiting persist
		this._changeCbs = new Set();
		this._started = false;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	start() {
		if (this._started) return;
		this._started = true;

		// Track the active agent: load its mood, reset the feed, re-express.
		onActiveAgentChange((agent) => this._adoptAgent(agent?.id || null, agent));
		this._adoptAgent(getActiveAgentId(), peekActiveAgent());

		// Real signal producers from the shared bus.
		agentBus.on(EVENTS.MEMORY_ADDED, (p) => this._onMemoryAdded(p));
		agentBus.on(EVENTS.MEMORY_RECALLED, (p) => this._onMemoryRecalled(p));
		agentBus.on(EVENTS.MEMORY_FORGOTTEN, (p) => this._maybeSignal(p, 'memory:forgotten'));
		agentBus.on(EVENTS.DREAM_CREATED, (p) => this._maybeSignal(p, 'dream:insight', { weight: clamp01(p?.confidence ?? 0.7), sourceLabel: p?.statement ? `Insight: ${String(p.statement).slice(0, 60)}` : undefined }));
		agentBus.on(EVENTS.ACTION_TAKEN, (p) => this._onAction(p));
		agentBus.on(EVENTS.BRAIN_UPDATED, (p) => this._maybeSignal(p, 'brain:updated'));

		// Decay tick — paused when the tab is hidden so a backgrounded avatar
		// doesn't silently drain its mood; on return we catch up with real elapsed.
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					this._lastTick = now();
					this._ensureTicking();
				} else {
					this._stopTicking();
				}
			});
		}
		this._ensureTicking();
	}

	_ensureTicking() {
		if (this._timer || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
		this._timer = setInterval(() => this._tick(), TICK_MS);
	}

	_stopTicking() {
		if (this._timer) clearInterval(this._timer);
		this._timer = null;
	}

	_adoptAgent(agentId, record) {
		this.agentId = agentId || null;
		const restored = this._restore(agentId, record);
		this.state = makeState(restored);
		this.sensitivity = clampSensitivity(restored.sensitivity);
		this._signals = [];
		this._lastTick = now();
		this._lastEmitted = { valence: NaN, arousal: NaN };   // force first emit
		this._emit(null);                                      // resting expression
	}

	// Restore a persisted snapshot, decaying it by real elapsed time since it was
	// written so a mood that was hot last session is appropriately cooled now.
	_restore(agentId, record) {
		let snap = record?.meta?.mood || null;
		if (!snap && agentId) {
			try {
				const raw = localStorage.getItem(LS_PREFIX + agentId);
				if (raw) snap = JSON.parse(raw);
			} catch { /* storage unavailable */ }
		}
		if (!snap || !Number.isFinite(snap.valence)) {
			return { ...BASELINE, sensitivity: DEFAULT_SENSITIVITY };
		}
		let state = { valence: snap.valence, arousal: Number.isFinite(snap.arousal) ? snap.arousal : BASELINE.arousal };
		const updated = snap.updated_at || snap.updatedAt;
		if (updated) {
			const elapsed = Date.parse(isoNow()) - Date.parse(updated);
			if (Number.isFinite(elapsed) && elapsed > 0) state = decay(state, Math.min(elapsed, 86_400_000));
		}
		return { ...state, sensitivity: snap.sensitivity };
	}

	// ── Signal intake ────────────────────────────────────────────────────────

	/** Apply a catalogue (or explicit) signal, record it, and re-express. */
	ingestSignal(source, opts = {}) {
		if (!this._started) return;
		const def = typeof source === 'string' ? SIGNALS[source] : source;
		if (!def) return;
		const next = applySignal(this.state, source, { weight: opts.weight, sensitivity: this.sensitivity });
		const moved = moodDistance(next, this.state) > 0.0005;
		this.state = next;
		this._recordSignal({
			source: typeof source === 'string' ? source : 'custom',
			label: opts.sourceLabel || def.label || 'Signal',
			memoryId: opts.memoryId || null,
		});
		// Persist + emit only when something actually moved (sensitivity 0 = stoic).
		if (moved) {
			this._emit({ source: typeof source === 'string' ? source : 'custom', label: opts.sourceLabel || def.label, memoryId: opts.memoryId || null });
			this._schedulePersist({ source: typeof source === 'string' ? source : 'custom', label: opts.sourceLabel || def.label, memoryId: opts.memoryId || null });
		}
	}

	/**
	 * Observe a real chat message and let its sentiment move the mood. Only the
	 * active agent's own conversation counts. Sentiment comes from the
	 * deterministic lexicon — real inference over the actual words, never random.
	 */
	observeChat(agentId, text, role = 'user') {
		if (!this._started) return;
		if (agentId && this.agentId && agentId !== this.agentId) return;
		const clean = String(text || '').trim();
		if (clean.length < 2) return;
		const { score } = scoreSentiment([{ text: clean }]);
		const sig = signalFromSentiment(score);
		if (!sig) return;
		this.ingestSignal(sig.signal, {
			weight: sig.weight,
			sourceLabel: role === 'assistant' ? 'Its own words' : 'What you said',
		});
	}

	_onMemoryAdded(p) {
		if (!this._sameAgent(p)) return;
		const salience = clamp01(p?.memory?.salience ?? 0.5);
		this.ingestSignal('memory:added', { weight: 0.5 + salience * 0.5, memoryId: p?.memory?.id || null });
	}

	_onMemoryRecalled(p) {
		if (!this._sameAgent(p)) return;
		// A flicker of recognition — scale gently by how much was recalled.
		const n = Array.isArray(p?.memories) ? p.memories.length : 1;
		this.ingestSignal('memory:recalled', { weight: Math.min(1, 0.4 + n * 0.15) });
	}

	_onAction(p) {
		if (!this._sameAgent(p)) return;
		const a = p?.action || p || {};
		const label = a.summary || a.title || a.label || a.kind || 'Took an action';
		// Prefer an explicit outcome flag when a producer supplies one.
		const ok = a.ok === true || a.success === true || a.outcome === 'success' || a.status === 'ok' || a.status === 'success';
		const bad = a.ok === false || a.success === false || Boolean(a.error) || a.outcome === 'failure' || a.status === 'error' || a.status === 'failed';
		if (ok) return this.ingestSignal('action:success', { sourceLabel: label });
		if (bad) return this.ingestSignal('action:failure', { sourceLabel: label });
		// No explicit outcome — read the receipt/summary text for real sentiment
		// (e.g. an alert about trouble reads negative). Otherwise a completed
		// action is a mild positive: the agent handled something for you.
		const { score } = scoreSentiment([{ text: String(label) }]);
		const sig = signalFromSentiment(score);
		if (sig) this.ingestSignal(sig.signal, { weight: sig.weight, sourceLabel: label });
		else this.ingestSignal('action:success', { weight: 0.45, sourceLabel: label });
	}

	_maybeSignal(p, source, opts = {}) {
		if (!this._sameAgent(p)) return;
		this.ingestSignal(source, opts);
	}

	_sameAgent(p) {
		// Untagged events (no agentId) are assumed to be about the active agent.
		return !p?.agentId || !this.agentId || p.agentId === this.agentId;
	}

	// ── Tick / decay ──────────────────────────────────────────────────────────

	_tick() {
		const t = now();
		const dt = t - this._lastTick;
		this._lastTick = t;
		if (dt <= 0) return;
		this.state = decay(this.state, dt);
		this._maybeEmit(null);
	}

	// ── Emission ──────────────────────────────────────────────────────────────

	_maybeEmit(signal) {
		const prevLabel = moodLabel(this._lastEmitted.valence, this._lastEmitted.arousal).key;
		const curLabel = moodLabel(this.state.valence, this.state.arousal).key;
		if (curLabel !== prevLabel || moodDistance(this.state, this._lastEmitted) >= EMIT_EPSILON) {
			this._emit(signal);
		}
	}

	_emit(signal) {
		const mood = moodLabel(this.state.valence, this.state.arousal);
		const transitionDistance = moodDistance(this.state, this._lastEmitted);
		this._lastEmitted = { valence: this.state.valence, arousal: this.state.arousal };
		const payload = {
			agentId: this.agentId,
			valence: round3(this.state.valence),
			arousal: round3(this.state.arousal),
			mood,
			sensitivity: this.sensitivity,
			signal: signal ? { source: signal.source, label: signal.label } : null,
			// A large jump (a real spike) tells the body to play a one-shot beat.
			beat: signal && Number.isFinite(transitionDistance) && transitionDistance >= GESTURE_DISTANCE,
			ts: isoNow(),
		};
		if (this.agentId) {
			try { agentBus.emit(EVENTS.MOOD_CHANGED, payload); } catch { /* bus isolated */ }
		}
		for (const cb of this._changeCbs) { try { cb(payload); } catch { /* subscriber isolated */ } }
		this._mirrorLocal();
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	_recordSignal({ source, label, memoryId }) {
		this._signals.unshift({
			source,
			label,
			memoryId: memoryId || null,
			valence: round3(this.state.valence),
			arousal: round3(this.state.arousal),
			mood: moodLabel(this.state.valence, this.state.arousal).key,
			ts: isoNow(),
		});
		if (this._signals.length > SIGNAL_LOG_MAX) this._signals.length = SIGNAL_LOG_MAX;
	}

	_mirrorLocal() {
		if (!this.agentId) return;
		try {
			localStorage.setItem(LS_PREFIX + this.agentId, JSON.stringify({
				valence: round3(this.state.valence),
				arousal: round3(this.state.arousal),
				label: moodLabel(this.state.valence, this.state.arousal).key,
				sensitivity: this.sensitivity,
				updated_at: isoNow(),
			}));
		} catch { /* storage full / unavailable — non-fatal */ }
	}

	_schedulePersist(signal) {
		this._pendingSignal = signal;
		if (!this.agentId || !isUuid(this.agentId)) return;   // guest/local-only mood
		if (this._persistTimer) clearTimeout(this._persistTimer);
		this._persistTimer = setTimeout(() => this._flushPersist(), PERSIST_DEBOUNCE_MS);
	}

	async _flushPersist() {
		this._persistTimer = null;
		const signal = this._pendingSignal;
		this._pendingSignal = null;
		if (!this.agentId || !isUuid(this.agentId) || !signal) return;
		try {
			await apiFetch(`/api/agents/${this.agentId}/mood`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					valence: round3(this.state.valence),
					arousal: round3(this.state.arousal),
					label: moodLabel(this.state.valence, this.state.arousal).key,
					sensitivity: this.sensitivity,
					source: signal.source,
					source_label: signal.label,
					source_memory_id: signal.memoryId || undefined,
				}),
			});
		} catch { /* not the owner / offline — local mirror already keeps continuity */ }
	}

	// ── Public surface ─────────────────────────────────────────────────────────

	getState() { return { valence: this.state.valence, arousal: this.state.arousal }; }
	getMood() { return moodLabel(this.state.valence, this.state.arousal); }
	getSensitivity() { return this.sensitivity; }
	recentSignals() { return this._signals.slice(); }

	/** Snapshot for a freshly-mounted surface (inspector, embodiment binder). */
	snapshot() {
		return {
			agentId: this.agentId,
			valence: round3(this.state.valence),
			arousal: round3(this.state.arousal),
			mood: this.getMood(),
			sensitivity: this.sensitivity,
			ts: isoNow(),
		};
	}

	/** Set emotional sensitivity (0 stoic … 1 expressive); persists as a setting. */
	async setSensitivity(value) {
		this.sensitivity = clampSensitivity(value);
		this._mirrorLocal();
		this._emit(null);
		if (this.agentId && isUuid(this.agentId)) {
			try {
				await apiFetch(`/api/agents/${this.agentId}/mood/sensitivity`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({ sensitivity: this.sensitivity }),
				});
			} catch { /* local mirror still holds the setting */ }
		}
		return this.sensitivity;
	}

	/** Fetch persisted history (for the inspector sparkline). */
	async loadHistory() {
		if (!this.agentId || !isUuid(this.agentId)) return [];
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/mood`, { credentials: 'include' });
			if (!res.ok) return [];
			const data = await res.json();
			return Array.isArray(data.history) ? data.history : [];
		} catch { return []; }
	}

	onChange(cb) {
		if (typeof cb !== 'function') return () => {};
		this._changeCbs.add(cb);
		try { cb(this.snapshot()); } catch { /* isolate */ }
		return () => this._changeCbs.delete(cb);
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }
function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

// Singleton across the app (survives HMR + duplicate module graphs).
const GLOBAL_KEY = '__threewsMoodEngine';
export const moodEngine =
	(typeof globalThis !== 'undefined' && globalThis[GLOBAL_KEY]) || new MoodEngine();
if (typeof globalThis !== 'undefined' && !globalThis[GLOBAL_KEY]) {
	globalThis[GLOBAL_KEY] = moodEngine;
}

// Auto-start in the browser so any page that imports the engine (or the
// embodiment binder) gets a live mood without extra wiring.
if (typeof window !== 'undefined') {
	moodEngine.start();
	window.__moodEngine = moodEngine;
}

export default moodEngine;
