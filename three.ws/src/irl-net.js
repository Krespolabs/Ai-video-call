// Realtime client for /irl — wraps colyseus.js with a tiny event API so irl.js
// can subscribe to live PRESENCE and REACTIONS without knowing anything about
// Colyseus. Mirrors walk-net.js in shape (status model, single-retry reconnect,
// no storms) so the two transports read the same.
//
// What it does: joins the irl_world room for the viewer's precision-6 geocell and
// relays the live viewer set (presence: count + opt-in ghosts) and ambient
// reactions. It deliberately does NOT transport pins — placed agents are private
// by location and are discovered only through the per-viewer proximity poll in
// irl.js, never broadcast here as a roster (see multiplayer/src/rooms/IrlRoom.js).
// When the viewer physically walks into a new geocell, moveTo() re-joins the room.
//
// Graceful degradation: if no server is configured for this environment, or the
// socket can't be reached after one retry, it settles into a distinct status
// (`unavailable` / `failed`) so presence is simply hidden — pin discovery is
// unaffected (it runs on the poll regardless), and the HUD pill hides rather than
// looping on a dead "reconnecting…" forever.

import { Client, getStateCallbacks } from 'colyseus.js';
import { IrlState } from '../multiplayer/src/irl-schemas.js';
import { joinRoomWithTimeout } from './shared/colyseus-connect.js';
import { encodeGeohash } from '../multiplayer/src/geohash.js';
import { log } from './shared/log.js';

const ROOM_NAME = 'irl_world';
const GEOCELL_PRECISION = 6;
const MAX_RETRIES = 1; // one jittered retry on failure/drop, then drop to poll

function defaultServerUrl() {
	// The IRL world runs on the SAME Colyseus host as /walk (a new room, not a new
	// process), so we resolve the walk-server config as a fallback — production sets
	// <meta name="walk-server">, and an explicit irl-server meta/env can override it.
	//   1. window.IRL_SERVER_URL / window.WALK_SERVER_URL   (runtime / test override)
	//   2. <meta name="irl-server"> / <meta name="walk-server">  (per-page prod config)
	//   3. VITE_IRL_SERVER_URL / VITE_WALK_SERVER_URL       (build-time prod config)
	//   4. Codespaces / Gitpod port-subdomain forwarding (-3000 → -2567)
	//   5. Same host on :2567                               (DEV ONLY convenience)
	// In production with none set we return '' so the caller stays in graceful poll
	// mode — the public domain doesn't expose :2567.
	if (typeof window !== 'undefined') {
		if (window.IRL_SERVER_URL) return String(window.IRL_SERVER_URL).trim().replace(/\/$/, '');
		if (window.WALK_SERVER_URL) return String(window.WALK_SERVER_URL).trim().replace(/\/$/, '');
	}
	if (typeof document !== 'undefined') {
		for (const name of ['irl-server', 'walk-server']) {
			const v = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim();
			if (v) return v.replace(/\/$/, '');
		}
	}
	try {
		const envUrl = import.meta?.env?.VITE_IRL_SERVER_URL || import.meta?.env?.VITE_WALK_SERVER_URL;
		if (envUrl) return String(envUrl).trim().replace(/\/$/, '');
	} catch (_) {}
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const host = location.hostname;
		const fwd = host.match(/^(.*)-(\d+)\.(app\.github\.dev|githubpreview\.dev|gitpod\.io)$/);
		if (fwd) return `${proto}//${fwd[1]}-2567.${fwd[3]}`;
		let isProd = false;
		try { isProd = import.meta?.env?.PROD === true; } catch (_) {}
		const isLocalHost = host === 'localhost' || host === '127.0.0.1';
		if (!isProd || isLocalHost) return `${proto}//${host}:2567`;
		return '';
	}
	return '';
}

export class IrlNet {
	/**
	 * @param {object} opts
	 * @param {number} opts.lat viewer latitude (picks the geocell)
	 * @param {number} opts.lng viewer longitude
	 * @param {string} [opts.deviceToken] anonymous device id (D2 presence / D4 attribution)
	 * @param {string} [opts.agent] three.ws agent id this viewer is embodying
	 * @param {boolean} [opts.ghost] D2 — broadcast self as a ghost marker (opt-in; default off)
	 * @param {string} [opts.avatar] D2 — GLB url to show as this viewer's ghost (only when ghost)
	 * @param {string} [opts.url] override server URL (otherwise resolved from meta)
	 */
	constructor(opts = {}) {
		this.lat = Number(opts.lat);
		this.lng = Number(opts.lng);
		this.deviceToken = opts.deviceToken || '';
		this.agent = opts.agent || '';
		// D2 presence opt-in — "appear to others nearby". Default off: a viewer is
		// always counted, but only broadcasts a positioned ghost when they opt in.
		this.ghost = opts.ghost === true;
		this.avatar = opts.avatar || '';
		this.url = opts.url || defaultServerUrl();
		this.geocell = encodeGeohash(this.lat, this.lng, GEOCELL_PRECISION);

		this.client = null;
		this.room = null;
		this.status = 'idle'; // idle | connecting | online | offline | failed | unavailable
		this.error = null;
		this._handlers = {
			status: new Set(),
			presence: new Set(), // D2 — live viewer count + opt-in ghosts
			reaction: new Set(), // D3 — ambient interaction reactions from the room
		};
		this._retries = 0;
		this._reconnectTimer = null;
		this._destroyed = false;
		this._connectGen = 0;
		this._presenceQueued = false; // coalesces a join-time burst of viewer deltas
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`IrlNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}

	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { log.error(`[irl-net] ${event} handler threw:`, e); }
		}
	}

	_setStatus(status, error = null) {
		this.status = status;
		this.error = error;
		this._emit('status', { status, error });
	}

	// Detach and close the current room without triggering a reconnect — every
	// (re)connect/moveTo replaces this.room, and a leftover socket would keep firing
	// schema callbacks alongside the new one (the same duplicate-event leak walk-net
	// guards against).
	_closeRoom() {
		const room = this.room;
		if (!room) return;
		this.room = null;
		try { room.removeAllListeners(); } catch {}
		try { room.leave(); } catch {}
	}

	async connect() {
		if (this._destroyed) return;
		this._closeRoom();
		// No server resolved for this environment → honest 'unavailable' (the page
		// still works via the poll fallback) instead of looping on a dead endpoint.
		if (!this.url) {
			this._setStatus('unavailable');
			return;
		}
		if (!this.geocell) {
			// No valid GPS cell yet — nothing to join; the caller polls until a fix lands.
			this._setStatus('unavailable');
			return;
		}
		const gen = ++this._connectGen;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			// `geocell` is the server's filterBy key (matchmaking): every viewer in the
			// same precision-6 cell joins one room instance.
			// Hard timeout on the join: a hung handshake would otherwise strand us in
			// 'connecting' forever — joinOrCreate has no timeout. On timeout this throws
			// and the catch below schedules a reconnect (then settles into 'unavailable',
			// where irl.js falls back to the proximity poll).
			const room = await joinRoomWithTimeout(this.client, ROOM_NAME, {
				geocell: this.geocell,
				deviceToken: this.deviceToken,
				agent: this.agent,
				lat: this.lat,
				lng: this.lng,
				// D2 — opt-in to being seen. The server snaps lat/lng to the cell centre
				// (coarse) regardless; ghost/avatar only ride when the viewer opted in.
				ghost: this.ghost,
				avatar: this.ghost ? this.avatar : '',
			}, IrlState);
			if (this._destroyed || gen !== this._connectGen) {
				try { room.leave(); } catch {}
				return;
			}
			this.room = room;
			this._retries = 0; // a clean connection resets the retry budget

			// Colyseus 0.16 moved schema callbacks behind getStateCallbacks(room).
			// NOTE: the room intentionally syncs NO pins — placed agents are never
			// broadcast as a roster (see IrlRoom.js); they're discovered only via the
			// per-viewer proximity poll in irl.js. This client consumes presence +
			// reactions only.
			const $ = getStateCallbacks(this.room);

			// D2 presence — the room's `viewers` MapSchema is the live crowd. Any
			// add / remove / per-viewer change re-derives the { count, viewers } the
			// HUD chip + ghost markers read. The join handshake fires onAdd once per
			// existing viewer, so we coalesce the burst into a single emit next tick.
			const $viewers = $(this.room.state)?.viewers;
			if ($viewers) {
				$viewers.onAdd((viewer) => {
					$(viewer).onChange(() => this._queuePresence());
					this._queuePresence();
				});
				$viewers.onRemove(() => this._queuePresence());
			}

			// D3 ambient reactions — the room broadcasts `reaction` to everyone in the
			// geocell when a co-located viewer taps / pays / messages a pin here. It's a
			// transient flourish (not schema state), so it rides a plain message, not a
			// MapSchema. Payload is privacy-stripped server-side to { pinId, type, ts }.
			this.room.onMessage('reaction', (msg) => this._emit('reaction', msg));

			this.room.onLeave((code) => {
				// A clean leave (1000) is us calling _closeRoom on destroy/moveTo — don't
				// reconnect. An unexpected drop schedules the single retry, then poll.
				if (this._destroyed || code === 1000) return;
				this._setStatus('offline');
				this._scheduleReconnect();
			});
			this.room.onError((code, message) => {
				log.warn('[irl-net] room.onError', code, message);
			});

			this._setStatus('online');
		} catch (err) {
			const reason = err?.message || (err?.code != null ? `code ${err.code}` : String(err));
			log.warn('[irl-net] connect failed:', reason);
			this._setStatus('failed', reason);
			this._scheduleReconnect();
		}
	}

	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		if (this._retries >= MAX_RETRIES) {
			// Out of retries — settle into 'unavailable' so the caller polls instead of
			// looping forever on a dead endpoint.
			this._setStatus('unavailable', this.error);
			return;
		}
		this._retries++;
		const delay = 2500 + Math.random() * 1500;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (this._destroyed) return;
			this.connect();
		}, delay);
	}

	/**
	 * Re-join the room for a new geocell when the viewer physically walks into one.
	 * No-op while still inside the current cell (the common case — cells are ~1.2 km).
	 */
	async moveTo(lat, lng) {
		this.lat = Number(lat);
		this.lng = Number(lng);
		const cell = encodeGeohash(this.lat, this.lng, GEOCELL_PRECISION);
		if (!cell || cell === this.geocell) return;
		this.geocell = cell;
		this._retries = 0; // a deliberate move gets a fresh connection budget
		await this.connect(); // leave the old room, join the new one
	}

	/**
	 * D3 — tell the room a viewer interacted with a pin, so it can fan an ambient
	 * reaction (agent emote + floating 💜/✨) to everyone else viewing this geocell.
	 * This is the *flourish* channel only: the durable record + owner notification
	 * already flow over the REST `/api/irl/interactions` path, so this is fire-and-
	 * forget and a no-op whenever the WS isn't live (poll fallback) — the record is
	 * never lost, only the live flourish is skipped.
	 * @param {{type:'open'|'view'|'pay'|'message', pinId:string, agentId?:string}} payload
	 * @returns {boolean} whether the emit was actually sent over a live socket
	 */
	interaction(payload) {
		// connection.isOpen catches the CLOSING/CLOSED window before onLeave flips
		// status — ws.send() there logs a console warning instead of throwing.
		if (this.status !== 'online' || !this.room || this.room.connection?.isOpen !== true) return false;
		const type = payload?.type;
		const pinId = payload?.pinId;
		if (!type || !pinId) return false;
		try {
			this.room.send('interaction', {
				type: String(type),
				pinId: String(pinId),
				agentId: payload.agentId ? String(payload.agentId) : '',
			});
			return true;
		} catch (e) {
			log.warn('[irl-net] interaction send failed:', e?.message || e);
			return false;
		}
	}

	/**
	 * D2 — prove we're still viewing and report our facing. The server refreshes
	 * this viewer's heartbeat timestamp (so the reaper keeps us) and updates the
	 * heading a shared ghost is oriented by. No-op off a live socket; presence is
	 * inherently live-only, so a missed heartbeat in poll fallback is correct.
	 * @param {number} headingDeg compass bearing 0–359 the viewer is facing
	 */
	heartbeat(headingDeg) {
		if (this.status !== 'online' || !this.room || this.room.connection?.isOpen !== true) return;
		const heading = Number.isFinite(headingDeg) ? headingDeg : 0;
		try { this.room.send('heartbeat', { heading }); } catch (e) {
			log.warn('[irl-net] heartbeat send failed:', e?.message || e);
		}
	}

	/**
	 * D2 — flip the "appear to others nearby" opt-in. Stored so a later (re)connect
	 * re-joins with the right intent, and pushed live over `set_ghost` so the marker
	 * appears / disappears for everyone in the cell without a rejoin.
	 * @param {boolean} ghost broadcast self as a positioned ghost
	 * @param {string} [avatar] GLB url to show as the ghost (ignored when ghost=false)
	 */
	setGhost(ghost, avatar) {
		this.ghost = ghost === true;
		if (avatar !== undefined) this.avatar = avatar || '';
		if (this.status !== 'online' || !this.room || this.room.connection?.isOpen !== true) return;
		try {
			this.room.send('set_ghost', { ghost: this.ghost, avatar: this.ghost ? this.avatar : '' });
		} catch (e) {
			log.warn('[irl-net] set_ghost send failed:', e?.message || e);
		}
	}

	// Coalesce a flurry of viewer deltas (notably the per-viewer onAdd burst the
	// join handshake fires) into one presence emit on the next microtask.
	_queuePresence() {
		if (this._presenceQueued || this._destroyed) return;
		this._presenceQueued = true;
		Promise.resolve().then(() => {
			this._presenceQueued = false;
			this._emitPresence();
		});
	}

	// Derive { count, viewers } from the live MapSchema and emit it. `count` is the
	// whole crowd (self included — the chip hides at ≤1). `viewers` is everyone
	// ELSE who opted into a ghost, mapped to the coarse render shape; non-ghost and
	// self entries never appear, so a marker is only ever drawn for opted-in others.
	_emitPresence() {
		if (this._destroyed || !this.room) return;
		const map = this.room.state?.viewers;
		if (!map) return;
		const selfId = this.room.sessionId;
		let count = 0;
		const viewers = [];
		map.forEach((v, id) => {
			count++;
			if (id === selfId || !v.ghost) return;
			viewers.push({
				id,
				glat: v.lat,
				glng: v.lng,
				heading: v.heading,
				avatar: v.avatar || '',
				ghost: true,
			});
		});
		this._emit('presence', { count, viewers });
	}

	/** Force a reconnect (e.g. the user tapped the offline pill). */
	retry() {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this._retries = 0;
		this.connect();
	}

	destroy() {
		this._destroyed = true;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this._closeRoom();
		this.client = null;
	}
}
