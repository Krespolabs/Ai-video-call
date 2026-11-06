// agent-screen-client.js — SSE client for the agent screen stream.
//
// Manages the EventSource connection to /api/agent-screen-stream, handles
// reconnection with backoff, and exposes a clean event interface so the
// 2D dashboard and 3D walk desk can both subscribe without duplicating logic.
//
// Usage:
//   const client = createAgentScreenClient(agentId, {
//     onFrame(frame)    — called with { ts, data?, activity, type, agentId }
//     onLog(entries)    — called with [{ ts, activity, type }] (backfill)
//     onOpen(info)      — called with { agentId, agentName }
//     onDark()          — called when the agent's stream goes dark
//     onReaction(payload) — called with { bursts: [{emoji, ts}], total } on viewer reactions
//     onError(err)      — called on connection error (non-fatal, will retry)
//   });
//   client.connect();
//   client.disconnect();
//   client.isConnected() → boolean

const STREAM_URL = (agentId) => `/api/agent-screen-stream?agentId=${encodeURIComponent(agentId)}`;
const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000]; // ms

export function createAgentScreenClient(agentId, handlers = {}) {
	const { onFrame, onLog, onOpen, onDark, onError, onReaction } = handlers;

	let es = null;
	let reconnectTimer = null;
	let reconnectAttempt = 0;
	let destroyed = false;
	let connected = false;

	function connect() {
		if (destroyed || es) return;
		es = new EventSource(STREAM_URL(agentId));

		es.addEventListener('open', () => {
			reconnectAttempt = 0;
			connected = true;
		});

		es.addEventListener('frame', (e) => {
			try {
				const frame = JSON.parse(e.data);
				onFrame?.(frame);
			} catch { /* malformed event */ }
		});

		es.addEventListener('log', (e) => {
			try {
				const { entries } = JSON.parse(e.data);
				onLog?.(entries || []);
			} catch { /* malformed event */ }
		});

		// The server sends `event: open` carrying { agentId, agentName, ts }. The
		// native EventSource 'open' (connection established) has no `.data`, so the
		// `if (e.data)` guard below distinguishes the two on the same listener.
		es.addEventListener('open', (e) => {
			if (e.data) {
				try { onOpen?.(JSON.parse(e.data)); } catch { /* ok */ }
			}
		});

		es.addEventListener('dark', () => {
			onDark?.();
		});

		// Live spectator reactions: { bursts: [{emoji, ts}], total }.
		es.addEventListener('reaction', (e) => {
			try { onReaction?.(JSON.parse(e.data)); } catch { /* malformed event */ }
		});

		es.addEventListener('ping', () => {
			// keepalive — no action needed
		});

		es.onerror = () => {
			connected = false;
			es?.close();
			es = null;
			if (destroyed) return;
			onError?.(new Error('stream disconnected'));
			const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
			reconnectAttempt++;
			reconnectTimer = setTimeout(connect, delay);
		};
	}

	function disconnect() {
		destroyed = true;
		connected = false;
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		if (es) { es.close(); es = null; }
	}

	function isConnected() { return connected && !destroyed; }

	return { connect, disconnect, isConnected };
}
