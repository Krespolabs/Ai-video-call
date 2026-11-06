// The Living-Agents event bus — a typed pub/sub singleton every client surface
// subscribes to so the agent feels alive everywhere without each page knowing
// about every feature. The HUD shows a "recalled" chip on `memory:recalled`;
// the Mind Palace animates a node on `memory:added`; the avatar re-expresses on
// `mood:changed`; the Companion re-greets on `brain:updated`.
//
// Defined by the Foundation task and treated as a FIXED API by every other
// Living-Agents feature. Each event carries `{ agentId, ...payload, ts }` where
// `ts` is an ISO string sourced from the server response (or passed by the
// caller) — never wall-clock invented at emit time except as a last-resort
// fallback, so cross-surface ordering stays honest.
//
// Why this is a nervous system and not a bare EventEmitter:
//   • Replay — a surface that mounts late (the Mind Palace opened mid-session)
//     can ask for the recent backlog and catch up instantly, so liveness never
//     depends on being mounted at emit time.
//   • Backpressure / coalescing — a burst of `memory:added` (bulk import, a
//     reflection pass) can be throttled per-subscriber so a heavy UI re-renders
//     at most once per window instead of thrashing.
//   • Wildcard tap — `on('*', …)` sees every event; the basis of the debug
//     overlay and any cross-feature instrumentation.
//   • Cross-context safe — no DOM/`window` access at import time, so it loads
//     cleanly under Node (tests) and in every browser context, and survives HMR
//     + duplicate module graphs via a single global instance.
//
// See agent-bus.d.ts for the full per-event payload typedefs (autocomplete for
// tasks 02–08).

export const AGENT_EVENTS = Object.freeze([
	'memory:added',
	'memory:recalled',
	'memory:updated',
	'memory:forgotten',
	'brain:updated',
	'mood:changed',
	'dream:created',
	'action:taken',
	'agent:changed',
]);

/**
 * Ergonomic, autocompleting alias for the event names so callers can write
 * `EVENTS.MEMORY_RECALLED` instead of a bare string and have a rename caught by
 * tooling. The string values ARE the contract — both forms interoperate.
 * @readonly
 */
export const EVENTS = Object.freeze({
	MEMORY_ADDED: 'memory:added',
	MEMORY_RECALLED: 'memory:recalled',
	MEMORY_UPDATED: 'memory:updated',
	MEMORY_FORGOTTEN: 'memory:forgotten',
	BRAIN_UPDATED: 'brain:updated',
	MOOD_CHANGED: 'mood:changed',
	DREAM_CREATED: 'dream:created',
	ACTION_TAKEN: 'action:taken',
	AGENT_CHANGED: 'agent:changed',
});

/** Wildcard subscription key — receives `(payload, type)` for every event. */
export const WILDCARD = '*';

const EVENT_SET = new Set(AGENT_EVENTS);
// How many recent events to retain per type for `{ replay: 'all' }` and the
// debug overlay's history. Deep enough to rebuild a late-mounting surface's
// view, shallow enough to stay memory-cheap on a long session.
const REPLAY_DEPTH = 50;

/**
 * Leading+trailing throttle. The first call fires immediately; calls inside the
 * window collapse into one trailing call carrying the most recent payload. This
 * is the backpressure primitive a burst of `memory:added` rides on so a
 * subscriber re-renders at most once per `ms`.
 */
function throttle(fn, ms) {
	let last = 0;
	let timer = null;
	let pending = null;
	const clock = () =>
		typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
	const invoke = (args) => {
		last = clock();
		fn(...args);
	};
	const wrapped = (...args) => {
		const elapsed = clock() - last;
		if (elapsed >= ms) {
			invoke(args);
		} else {
			pending = args;
			if (!timer) {
				timer = setTimeout(() => {
					timer = null;
					if (pending) {
						const a = pending;
						pending = null;
						invoke(a);
					}
				}, ms - elapsed);
			}
		}
	};
	wrapped.cancel = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		pending = null;
	};
	return wrapped;
}

class AgentBus {
	constructor() {
		/** @type {Map<string, Set<Function>>} typed subscribers */
		this._typed = new Map();
		/** @type {Set<Function>} wildcard subscribers (see every event) */
		this._wild = new Set();
		// Most recent payload per event — late subscribers sync to current state
		// without waiting for the next emit (e.g. a HUD mounted after
		// `brain:updated` already fired).
		this._last = new Map();
		// Bounded per-type history for full backlog replay.
		this._log = new Map();
	}

	_assert(type) {
		if (!EVENT_SET.has(type)) {
			throw new Error(`[agent-bus] unknown event "${type}". Known: ${AGENT_EVENTS.join(', ')}`);
		}
	}

	/**
	 * Emit an event. `detail` must carry `agentId`; `ts` is normalised to an ISO
	 * string (server-provided when available, else stamped at emit as a fallback).
	 * Subscribers are isolated: one that throws is logged and never blocks the
	 * others or the emitter. Returns the frozen, delivered payload.
	 */
	emit(type, detail = {}) {
		this._assert(type);
		const payload = { ...detail };
		if (!payload.ts) payload.ts = new Date().toISOString();
		Object.freeze(payload);
		this._last.set(type, payload);
		this._record(type, payload);

		// Snapshot the sets so a subscriber that (un)subscribes during dispatch
		// can't mutate what we're iterating.
		const set = this._typed.get(type);
		if (set) for (const h of [...set]) this._safe(h, payload, type, set);
		if (this._wild.size) for (const h of [...this._wild]) this._safe(h, payload, type, this._wild);
		return payload;
	}

	/**
	 * Subscribe to an event (or {@link WILDCARD} for all). Returns an unsubscribe
	 * function.
	 *
	 * @param {string} type - An {@link AGENT_EVENTS} value, or `'*'`.
	 * @param {(payload:Object, type?:string)=>void} handler
	 * @param {Object} [opts]
	 * @param {boolean|'all'} [opts.replay] - `true` immediately delivers the last
	 *   payload (if any); `'all'` delivers the retained backlog oldest→newest so a
	 *   late-mounting surface fully catches up. Ignored for the wildcard.
	 * @param {number} [opts.throttleMs] - Coalesce bursts: deliver at most once
	 *   per this many ms (leading + trailing). Backpressure for high-rate events.
	 * @param {AbortSignal} [opts.signal] - Auto-unsubscribe when the signal aborts.
	 * @returns {() => void} unsubscribe
	 */
	on(type, handler, opts = {}) {
		if (typeof handler !== 'function') {
			throw new TypeError('[agent-bus] on(type, handler) requires a function');
		}
		const wildcard = type === WILDCARD;
		if (!wildcard) this._assert(type);

		const wrapped = opts.throttleMs ? throttle(handler, opts.throttleMs) : handler;
		const bucket = wildcard ? this._wild : this._getTyped(type);
		bucket.add(wrapped);

		const off = () => {
			bucket.delete(wrapped);
			if (!wildcard && !bucket.size) this._typed.delete(type);
			if (wrapped.cancel) wrapped.cancel();
		};

		if (opts.signal) {
			if (opts.signal.aborted) {
				off();
				return () => {};
			}
			opts.signal.addEventListener('abort', off, { once: true });
		}

		if (!wildcard && opts.replay) {
			if (opts.replay === 'all') {
				for (const p of this._log.get(type) || []) this._safe(wrapped, p, type, bucket);
			} else if (this._last.has(type)) {
				this._safe(wrapped, this._last.get(type), type, bucket);
			}
		}
		return off;
	}

	/** Subscribe for a single emission, then auto-unsubscribe. */
	once(type, handler) {
		const off = this.on(type, (payload, t) => {
			off();
			handler(payload, t);
		});
		return off;
	}

	/** Last payload seen for an event, or null. */
	last(type) {
		this._assert(type);
		return this._last.get(type) || null;
	}

	/** Retained backlog for an event (oldest→newest), without subscribing. */
	backlog(type) {
		this._assert(type);
		return [...(this._log.get(type) || [])];
	}

	/** Drop all subscribers and history. Primarily for tests. */
	reset() {
		for (const set of this._typed.values()) {
			for (const h of set) if (h.cancel) h.cancel();
		}
		for (const h of this._wild) if (h.cancel) h.cancel();
		this._typed.clear();
		this._wild.clear();
		this._last.clear();
		this._log.clear();
	}

	_getTyped(type) {
		let set = this._typed.get(type);
		if (!set) {
			set = new Set();
			this._typed.set(type, set);
		}
		return set;
	}

	_record(type, payload) {
		let log = this._log.get(type);
		if (!log) {
			log = [];
			this._log.set(type, log);
		}
		log.push(payload);
		if (log.length > REPLAY_DEPTH) log.shift();
	}

	_safe(handler, payload, type, owner) {
		// A handler removed earlier in this same dispatch pass must not fire.
		if (owner && !owner.has(handler)) return;
		try {
			handler(payload, type);
		} catch (err) {
			console.error(`[agent-bus] subscriber for "${type}" threw`, err);
		}
	}
}

// Singleton across the whole app, surviving HMR and duplicate module graphs by
// stashing on the global. Every `import { agentBus }` resolves to one instance.
const GLOBAL_KEY = '__threewsAgentBus';
export const agentBus =
	(typeof globalThis !== 'undefined' && globalThis[GLOBAL_KEY]) || new AgentBus();
if (typeof globalThis !== 'undefined' && !globalThis[GLOBAL_KEY]) {
	globalThis[GLOBAL_KEY] = agentBus;
}

// Browser-only conveniences. The debug overlay is a dev tool, not product UI:
// it loads only when the operator opts in with ?agentbus=1. The dynamic import
// keeps it out of every page's bundle and out of Node test runs.
if (typeof window !== 'undefined') {
	window.__agentBus = agentBus;
	try {
		const flag = new URLSearchParams(window.location.search).get('agentbus');
		if (flag === '1' || flag === 'true') {
			import('./agent-bus-debug.js')
				.then((m) => m.mountAgentBusDebug?.())
				.catch(() => {});
		}
	} catch {
		/* location unavailable (sandboxed iframe) — overlay simply doesn't mount */
	}
}

export default agentBus;
