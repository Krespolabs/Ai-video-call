// Walk session persistence — resume where you left off.
//
// Captures the live /walk state (selected avatar, environment, camera mode, last
// position/heading, trail style, recent gestures, companion prefs, multiplayer
// room) and restores it on the next visit so returning to /walk continues from
// the last known state instead of starting over.
//
// Two storage tiers, last-write-wins:
//   · Signed-in users sync to /api/walk/session (PUT/GET), so the same state
//     follows them across browsers and devices.
//   · Everyone falls back to localStorage — the anonymous/offline path, and the
//     instant local cache even for signed-in users (the server read overlays it
//     when fresher).
//
// Saves are debounced (a burst of changes collapses into one write), throttled to
// at most every 30s while active, and flushed once on pagehide via sendBeacon so a
// closed tab still records the final state. Restore applies only a snapshot that
// is < 7 days old and surfaces a small "Welcome back" toast with a "Start fresh"
// action that wipes the saved state.
//
// The walk runtime (src/walk.js) owns the actual scene; this module is a thin
// state mirror. walk.js passes `capture` (read live state → snapshot) and
// `restore` (apply a snapshot → scene) callbacks; everything else — storage,
// auth tiering, debouncing, the toast — lives here.

import { log } from './shared/log.js';

const LS_KEY = 'twx_walk_session';
const ENDPOINT = '/api/walk/session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // restore only snapshots < 7 days old
const SAVE_DEBOUNCE_MS = 1500; // collapse a burst of changes into one write
const SAVE_THROTTLE_MS = 30_000; // at most one periodic save per 30s while active
const SCHEMA_VERSION = 1;

// ── localStorage tier ───────────────────────────────────────────────────────

function readLocal() {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeLocal(envelope) {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(envelope));
	} catch {
		// Private mode / quota — the server tier (when signed in) still persists,
		// and an in-tab session keeps running regardless.
	}
}

function clearLocal() {
	try {
		localStorage.removeItem(LS_KEY);
	} catch {
		/* nothing more we can do */
	}
}

// ── server tier ─────────────────────────────────────────────────────────────
// A GET that 401s means "not signed in" → localStorage is the source of truth.
// Any non-2xx/401 (offline, 5xx) degrades to localStorage too, never throws.

async function fetchServerState() {
	try {
		const res = await fetch(ENDPOINT, {
			method: 'GET',
			credentials: 'include',
			headers: { accept: 'application/json' },
		});
		if (res.status === 401) return { signedIn: false, state: null, updatedAt: null };
		if (res.status === 204) return { signedIn: true, state: null, updatedAt: null };
		if (!res.ok) return { signedIn: null, state: null, updatedAt: null };
		const data = await res.json().catch(() => null);
		return {
			signedIn: true,
			state: data?.state ?? null,
			updatedAt: data?.updatedAt ? Date.parse(data.updatedAt) : null,
		};
	} catch {
		// Offline / network error — treat as "unknown auth", fall back to local.
		return { signedIn: null, state: null, updatedAt: null };
	}
}

async function putServerState(state) {
	try {
		const res = await fetch(ENDPOINT, {
			method: 'PUT',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ state }),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ── public controller ───────────────────────────────────────────────────────

/**
 * Wire walk session persistence into the running /walk page.
 *
 * @param {object} opts
 * @param {() => (object|null)} opts.capture  Read the live scene → a plain snapshot.
 * @param {(snapshot: object) => void} opts.restore  Apply a snapshot → the scene.
 * @returns {{
 *   ready: Promise<{ restored: boolean, source: 'server'|'local'|null }>,
 *   save: () => void,
 *   touch: () => void,
 *   startFresh: () => void,
 *   isSignedIn: () => (boolean|null),
 * }}
 */
export function createWalkSession({ capture, restore }) {
	if (typeof capture !== 'function' || typeof restore !== 'function') {
		throw new Error('createWalkSession requires capture() and restore() callbacks');
	}

	let signedIn = null; // null = unknown until first server read resolves
	let debounceTimer = 0;
	let lastSaveAt = 0;
	let destroyed = false;

	// Build the persisted envelope from the current live state.
	function envelope() {
		const state = capture() || {};
		state.savedAt = Date.now();
		return { v: SCHEMA_VERSION, savedAt: state.savedAt, state };
	}

	function persistNow() {
		if (destroyed) return;
		const env = envelope();
		lastSaveAt = Date.now();
		writeLocal(env); // always cache locally (instant, offline-safe)
		if (signedIn) putServerState(env.state); // cross-device sync for authed users
	}

	// Debounced save: a burst of meaningful changes collapses into one write.
	function save() {
		if (destroyed) return;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(persistNow, SAVE_DEBOUNCE_MS);
	}

	// Throttled periodic save while active (the 30s heartbeat). Skips the write if
	// a save already happened within the window, so it never competes with `save`.
	function touch() {
		if (destroyed) return;
		if (Date.now() - lastSaveAt < SAVE_THROTTLE_MS) return;
		persistNow();
	}

	// Final flush on pagehide. The snapshot is committed to localStorage
	// synchronously (the durable record that survives the unload), and for
	// signed-in users a fire-and-forget keepalive PUT lets the last state reach
	// the server so cross-device sync catches it even when the tab is closing.
	function flushOnHide() {
		if (destroyed) return;
		clearTimeout(debounceTimer);
		const env = envelope();
		writeLocal(env);
		if (signedIn) {
			// keepalive lets the request outlive the page; best-effort, never awaited.
			try {
				fetch(ENDPOINT, {
					method: 'PUT',
					credentials: 'include',
					keepalive: true,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ state: env.state }),
				}).catch(() => {});
			} catch {
				/* best-effort */
			}
		}
	}

	// Wipe every tier and clear the in-memory cadence so nothing re-saves the old
	// state. Surfaced as the "Start fresh" toast action.
	function startFresh() {
		clearTimeout(debounceTimer);
		lastSaveAt = Date.now(); // suppress an immediate periodic re-save
		clearLocal();
		if (signedIn) {
			// Persist an empty snapshot so the cleared state syncs across devices too.
			putServerState({});
		}
	}

	// Resolve the freshest available snapshot, restore it, and report what was
	// applied. Server wins when signed in and fresher-or-equal; otherwise local.
	async function bootstrap() {
		const local = readLocal();
		const server = await fetchServerState();
		signedIn = server.signedIn;

		const candidates = [];
		if (server.state && Object.keys(server.state).length) {
			const at = server.updatedAt || serverSavedAt(server.state) || 0;
			candidates.push({ source: 'server', state: server.state, at });
		}
		if (local?.state && Object.keys(local.state).length) {
			candidates.push({ source: 'local', state: local.state, at: local.savedAt || 0 });
		}
		if (!candidates.length) return { restored: false, source: null };

		// Freshest wins; ties favour the server (cross-device truth).
		candidates.sort((a, b) => b.at - a.at || (a.source === 'server' ? -1 : 1));
		const best = candidates[0];

		// Freshness gate — never resurrect a stale world the user has moved on from.
		if (!best.at || Date.now() - best.at > MAX_AGE_MS) {
			return { restored: false, source: null };
		}

		try {
			restore(best.state);
		} catch (err) {
			log.warn('[walk-session] restore failed:', err?.message || err);
			return { restored: false, source: null };
		}

		// If the server held a snapshot but the user isn't signed in here, the local
		// copy is now authoritative; if signed-in but only local existed, sync it up
		// so the other devices converge. Both are cheap last-write-wins writes.
		if (best.source === 'local' && signedIn) putServerState(best.state);

		return { restored: true, source: best.source, savedAt: best.at };
	}

	const ready = bootstrap();

	// 30s heartbeat while the tab is visible — the periodic snapshot from the spec.
	const heartbeat = setInterval(() => {
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
		touch();
	}, SAVE_THROTTLE_MS);

	// Snapshot on the way out (tab close / navigation / background on mobile).
	const onPageHide = () => flushOnHide();
	const onVisibility = () => {
		if (document.visibilityState === 'hidden') flushOnHide();
	};
	window.addEventListener('pagehide', onPageHide);
	window.addEventListener('beforeunload', onPageHide);
	document.addEventListener('visibilitychange', onVisibility);

	function destroy() {
		destroyed = true;
		clearTimeout(debounceTimer);
		clearInterval(heartbeat);
		window.removeEventListener('pagehide', onPageHide);
		window.removeEventListener('beforeunload', onPageHide);
		document.removeEventListener('visibilitychange', onVisibility);
	}

	return {
		ready,
		save,
		touch,
		startFresh,
		destroy,
		isSignedIn: () => signedIn,
	};
}

function serverSavedAt(state) {
	const v = state && typeof state.savedAt === 'number' ? state.savedAt : 0;
	return Number.isFinite(v) ? v : 0;
}

// ── "Welcome back" toast ─────────────────────────────────────────────────────
// A small, self-contained, dismissible toast announcing the resume with a
// "Start fresh" action. Canvas-first page, so it ships its own minimal styling
// using brand custom properties rather than pulling in a component.

export function showWelcomeBackToast({ onStartFresh, sceneLabel } = {}) {
	if (typeof document === 'undefined') return;

	const host = document.createElement('div');
	host.className = 'walk-resume-toast';
	host.setAttribute('role', 'status');
	host.setAttribute('aria-live', 'polite');
	host.style.cssText = [
		'position:fixed',
		'left:50%',
		'bottom:calc(env(safe-area-inset-bottom,0) + 88px)',
		'transform:translateX(-50%) translateY(12px)',
		'z-index:62',
		'display:flex',
		'align-items:center',
		'gap:14px',
		'max-width:min(92vw,440px)',
		'padding:11px 12px 11px 18px',
		'border-radius:14px',
		'background:rgba(17,17,20,0.92)',
		'border:1px solid rgba(255,255,255,0.12)',
		'box-shadow:0 12px 40px rgba(0,0,0,0.5)',
		'backdrop-filter:blur(16px)',
		'-webkit-backdrop-filter:blur(16px)',
		'color:#f4f5f8',
		'font:500 13px/1.35 var(--font-body,Inter,system-ui,sans-serif)',
		'opacity:0',
		'transition:opacity .28s ease,transform .28s ease',
	].join(';');

	const text = document.createElement('div');
	text.style.cssText = 'flex:1;min-width:0';
	const title = document.createElement('div');
	title.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:1px';
	title.textContent = 'Welcome back';
	const sub = document.createElement('div');
	sub.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.62)';
	sub.textContent = sceneLabel
		? `Resumed where you left off in ${sceneLabel}.`
		: 'Resumed where you left off.';
	text.append(title, sub);

	const freshBtn = document.createElement('button');
	freshBtn.type = 'button';
	freshBtn.textContent = 'Start fresh';
	freshBtn.style.cssText = [
		'appearance:none',
		'flex:0 0 auto',
		'border:1px solid rgba(255,255,255,0.2)',
		'background:rgba(255,255,255,0.06)',
		'color:#fff',
		'border-radius:999px',
		'padding:6px 14px',
		'font:inherit',
		'font-size:12px',
		'font-weight:600',
		'cursor:pointer',
		'transition:background .15s ease,border-color .15s ease',
	].join(';');
	freshBtn.addEventListener('mouseenter', () => {
		freshBtn.style.background = 'rgba(255,255,255,0.14)';
		freshBtn.style.borderColor = 'rgba(255,255,255,0.34)';
	});
	freshBtn.addEventListener('mouseleave', () => {
		freshBtn.style.background = 'rgba(255,255,255,0.06)';
		freshBtn.style.borderColor = 'rgba(255,255,255,0.2)';
	});

	const closeBtn = document.createElement('button');
	closeBtn.type = 'button';
	closeBtn.setAttribute('aria-label', 'Dismiss');
	closeBtn.textContent = '×';
	closeBtn.style.cssText = [
		'appearance:none',
		'flex:0 0 auto',
		'border:none',
		'background:transparent',
		'color:rgba(255,255,255,0.5)',
		'font:400 20px/1 system-ui,sans-serif',
		'cursor:pointer',
		'padding:2px 6px',
		'border-radius:8px',
		'transition:color .15s ease',
	].join(';');
	closeBtn.addEventListener('mouseenter', () => (closeBtn.style.color = '#fff'));
	closeBtn.addEventListener('mouseleave', () => (closeBtn.style.color = 'rgba(255,255,255,0.5)'));

	let dismissTimer = 0;
	function dismiss() {
		clearTimeout(dismissTimer);
		host.style.opacity = '0';
		host.style.transform = 'translateX(-50%) translateY(12px)';
		setTimeout(() => host.remove(), 320);
	}

	freshBtn.addEventListener('click', () => {
		try {
			onStartFresh?.();
		} catch (err) {
			log.warn('[walk-session] start-fresh failed:', err?.message || err);
		}
		title.textContent = 'Starting fresh';
		sub.textContent = 'Your saved walk has been cleared.';
		freshBtn.remove();
		clearTimeout(dismissTimer);
		dismissTimer = setTimeout(dismiss, 2200);
	});
	closeBtn.addEventListener('click', dismiss);
	host.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') dismiss();
	});

	host.append(text, freshBtn, closeBtn);
	document.body.appendChild(host);
	requestAnimationFrame(() => {
		host.style.opacity = '1';
		host.style.transform = 'translateX(-50%) translateY(0)';
	});
	// Auto-dismiss after a while if untouched; the action stays available until then.
	dismissTimer = setTimeout(dismiss, 12_000);

	return { dismiss };
}
