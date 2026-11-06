/**
 * Mission Control — real-time plumbing.
 *
 * Two primitives the cockpit is built on:
 *
 *   • Bus       — a dependency-free pub/sub so panes never reach into each
 *                 other. The feed publishes `mint`/`trade`, the focus pane
 *                 subscribes; positions publishes `position`, the keyboard
 *                 controller subscribes. One bus, many readers.
 *
 *   • SseClient — a resilient EventSource wrapper. The server-side SSE endpoints
 *                 (api/sniper/stream.js, api/pump/trades-stream.js) deliberately
 *                 close every ~90s with an `event: close` to bound serverless
 *                 duration; that is a NORMAL lifecycle, not an error, so we
 *                 reconnect immediately on a graceful close and only apply
 *                 exponential backoff on real failures. Connection state is
 *                 surfaced honestly (live / reconnecting / down) — never faked.
 */

/** Tiny synchronous pub/sub. Handlers that throw never break other handlers. */
export function createBus() {
	const channels = new Map();
	return {
		on(event, fn) {
			if (!channels.has(event)) channels.set(event, new Set());
			channels.get(event).add(fn);
			return () => channels.get(event)?.delete(fn);
		},
		emit(event, payload) {
			const subs = channels.get(event);
			if (!subs) return;
			for (const fn of subs) {
				try {
					fn(payload);
				} catch (err) {
					console.error(`[mission-control] bus handler for "${event}" threw`, err);
				}
			}
		},
		clear() {
			channels.clear();
		},
	};
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
// After this many consecutive failed reconnects we report 'down' (still trying,
// but the UI tells the user the source is unreachable rather than just "slow").
const DOWN_AFTER_FAILURES = 4;

/**
 * Resilient SSE client.
 *
 * @param {object} opts
 * @param {string} opts.url                         — endpoint (without it being opened yet)
 * @param {Record<string,(data:any)=>void>} opts.events — named SSE event → handler
 * @param {(state:'live'|'reconnecting'|'down', meta?:object)=>void} [opts.onState]
 * @returns {{ start():void, stop():void, isLive():boolean }}
 */
export function createSseClient({ url, events = {}, onState = () => {} }) {
	let es = null;
	let stopped = false;
	let failures = 0;
	let reconnectTimer = null;
	let state = 'reconnecting';

	function setState(next, meta) {
		if (state === next) return;
		state = next;
		onState(next, meta);
	}

	function clearReconnect() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	}

	function teardownSource() {
		if (es) {
			es.onopen = null;
			es.onerror = null;
			try {
				es.close();
			} catch {
				/* already closed */
			}
			es = null;
		}
	}

	function scheduleReconnect(graceful) {
		teardownSource();
		if (stopped) return;
		clearReconnect();
		// A graceful server-side cycle (duration cap) reconnects fast to keep the
		// stream continuous; a real error backs off exponentially with jitter.
		const delay = graceful
			? 250 + Math.floor(Math.random() * 250)
			: Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 6)) +
				Math.floor(Math.random() * 400);
		reconnectTimer = setTimeout(connect, delay);
	}

	function connect() {
		if (stopped) return;
		clearReconnect();
		teardownSource();
		try {
			es = new EventSource(url, { withCredentials: true });
		} catch {
			failures += 1;
			setState(failures >= DOWN_AFTER_FAILURES ? 'down' : 'reconnecting');
			scheduleReconnect(false);
			return;
		}

		es.onopen = () => {
			failures = 0;
			setState('live');
		};

		es.onerror = () => {
			// EventSource may be mid-retry (CONNECTING). We take deterministic
			// control: tear it down and reconnect ourselves with backoff so the
			// connection-state indicator and timing are honest and bounded.
			if (stopped) return;
			failures += 1;
			setState(failures >= DOWN_AFTER_FAILURES ? 'down' : 'reconnecting');
			scheduleReconnect(false);
		};

		for (const [name, fn] of Object.entries(events)) {
			es.addEventListener(name, (ev) => {
				let data = null;
				try {
					data = ev.data ? JSON.parse(ev.data) : null;
				} catch {
					data = null;
				}
				// `close` from the server is its duration-cap cycle — reconnect now.
				if (name === 'close') {
					scheduleReconnect(true);
					return;
				}
				try {
					fn(data, ev);
				} catch (err) {
					console.error(`[mission-control] SSE "${name}" handler threw`, err);
				}
			});
		}
	}

	return {
		start() {
			stopped = false;
			failures = 0;
			setState('reconnecting');
			connect();
		},
		stop() {
			stopped = true;
			clearReconnect();
			teardownSource();
		},
		isLive: () => state === 'live',
	};
}
