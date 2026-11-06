// ── colyseus-connect.js — bounded room join for every multiplayer client ────
//
// Colyseus's `joinOrCreate` resolves only after the server completes the
// JOIN_ROOM handshake that follows the WebSocket open — and it gives that wait
// no timeout. A socket that opens but never finishes the handshake leaves the
// promise pending *forever*: it neither resolves nor rejects. That happens in
// the wild more than the happy path suggests —
//   • a Cloud Run instance scaled to zero accepts the upgrade while still
//     cold-booting the room process,
//   • a wedged or GC-paused room never sends JOIN_ROOM,
//   • a proxy / load balancer holds the upgrade open without forwarding it.
//
// With no rejection there is no `catch`, so the client is stranded in a
// terminal 'connecting' state: the status pill reads "Connecting…" indefinitely
// and the reconnect/offline fallback (which only fires on an error) never runs.
// That is the stuck-on-connecting bug this guard removes.
//
// We race the join against a hard timeout. If the join wins, its room is
// returned unchanged. If the timeout wins we throw a tagged
// `Error('connect_timeout')` so the caller's existing catch reconnects with
// backoff (and, after its attempts are spent, falls back to single-player).
//
// A join that resolves *after* the timeout fired is abandoned and its room is
// left — a zombie handshake must never orphan a second live socket, which would
// double-deliver every broadcast (the duplicate-chat leak the callers' own
// generation guards also defend against).

// Generous enough to clear a Cloud Run cold start (instance boot + room spawn +
// handshake), tight enough that a genuinely dead endpoint surfaces an error and
// reconnects rather than hanging. Reconnect backoff handles the retry cadence.
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Join (or create) a Colyseus room with a hard client-side timeout.
 *
 * @template T
 * @param {import('colyseus.js').Client} client  a live Colyseus client
 * @param {string} roomName                       matchmaking room name
 * @param {Record<string, unknown>} options       join options (filterBy keys, identity…)
 * @param {T} [schema]                            optional concrete root-state schema class.
 *   Prefer omitting it: when absent, colyseus.js decodes state from the schema the
 *   SERVER reflects during the join handshake (SchemaSerializer.handshake →
 *   Reflection.decode), so the client's field layout always tracks the running
 *   server. Passing a statically-bundled class instead forces the client to decode
 *   with its own copy — which silently desyncs the instant the deployed server adds
 *   an (append-only) field the bundle predates, flooding the console with
 *   `@colyseus/schema: field not defined` / `definition mismatch` / `Invalid byte`
 *   and rendering a broken world until the front-end is redeployed. Reflection has
 *   no such failure mode; the field-name callbacks (getStateCallbacks) work either way.
 * @param {number} [timeoutMs]                    join deadline; defaults to CONNECT_TIMEOUT_MS
 * @returns {Promise<import('colyseus.js').Room>} the joined room
 * @throws {Error} `connect_timeout` if the handshake doesn't complete in time
 */
export async function joinRoomWithTimeout(client, roomName, options, schema, timeoutMs = CONNECT_TIMEOUT_MS) {
	const joinPromise = client.joinOrCreate(roomName, options, schema);
	let timer = null;
	let timedOut = false;
	try {
		return await Promise.race([
			joinPromise,
			new Promise((_, reject) => {
				timer = setTimeout(() => { timedOut = true; reject(new Error('connect_timeout')); }, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
		// If the timeout won the race, the join may still be in flight. Attach
		// handlers now (the second `() => {}` swallows a late rejection so it never
		// surfaces as an unhandled promise) and leave any room it eventually yields.
		if (timedOut) joinPromise.then((room) => { try { room.leave(); } catch {} }, () => {});
	}
}
