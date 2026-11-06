// "Anchor to a marker" — the /irl indoor colocalization UI (Epic M).
//
// Self-contained on the same contract as src/irl/room-mode.js: it builds its OWN
// DOM (entry button, scan HUD, lock box, place panel, marker-maker sheet) and
// injects its OWN styles, so src/irl.js needs only a single additive hook
// (initMarkerMode) and never edits shared markup. All geometry rides the pure,
// unit-tested src/irl/{marker-anchor,marker-pose,qr-detect}.js; the camera→world
// step and the network/scene calls come in through injected deps, exactly like
// room-mode, so this file holds no Three.js and no fetch.
//
// The interaction: enter the mode, point the camera at a QR marker (yours, or one
// you make here). When it locks, the marker becomes a SHARED origin both phones
// agree on with no GPS and no compass — so you walk to a spot, tap "Place here",
// and the agent anchors relative to the marker. Anyone who opens /irl and scans
// the same marker sees that agent standing in the same physical place. This is the
// indoor path GPS can't do: see the module header of marker-anchor.js for why.

import {
	markerRoomId,
	normalizeMarkerPayload,
} from './marker-anchor.js';
import {
	qrDetectionAvailable,
	startQrScanLoop,
} from './qr-detect.js';

// Same accent + pill language as room-mode so the two authoring modes feel like
// one family. A marker token we generate is a short, unguessable, URL-safe id.
const STABLE_LOCK_FRAMES = 3; // consecutive agreeing detections before we commit a lock
const MARKER_URL_BASE = 'https://three.ws/irl';

function randomToken() {
	// 10 chars of base36 — ~52 bits, plenty to keep two ad-hoc markers distinct.
	let s = '';
	for (let i = 0; i < 10; i++) s += Math.floor(Math.random() * 36).toString(36);
	return s;
}
function markerUrl(token) {
	return `${MARKER_URL_BASE}?m=${encodeURIComponent(token)}`;
}

let _stylesInjected = false;
function injectStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const css = `
.irl-marker-fab.is-active{background:rgba(56,189,248,.22);border-color:rgba(56,189,248,.7);color:#fff}
#irl-marker-hud{position:fixed;inset:0;z-index:6;pointer-events:none;display:none;color:#fff;font:inherit}
#irl-marker-hud.is-open{display:block}
.irl-mk-frame{position:absolute;inset:0;pointer-events:none}
.irl-mk-frame svg{position:absolute;inset:0;width:100%;height:100%}
.irl-mk-recticle{position:absolute;top:46%;left:50%;width:180px;height:180px;margin:-90px 0 0 -90px;
  border-radius:18px;border:2px dashed rgba(255,255,255,.5);transition:opacity .2s ease}
.irl-mk-hud-locked .irl-mk-recticle{opacity:0}
.irl-mk-panel{position:absolute;left:0;right:0;bottom:0;pointer-events:auto;
  padding:14px 16px calc(16px + env(safe-area-inset-bottom));
  background:linear-gradient(to top,rgba(8,8,16,.94),rgba(8,8,16,.55) 70%,transparent);
  display:flex;flex-direction:column;gap:12px}
.irl-mk-coach{font-size:13.5px;line-height:1.45;color:rgba(255,255,255,.86);text-align:center;margin:0}
.irl-mk-coach[data-tone="warn"]{color:#fcd34d}
.irl-mk-coach[data-tone="ok"]{color:#7ee0a8}
.irl-mk-actions{display:flex;gap:10px;align-items:stretch}
.irl-mk-btn{min-height:52px;padding:0 16px;border-radius:14px;font-size:15px;font-weight:700;color:#fff;cursor:pointer;
  border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.1);transition:transform .12s ease,filter .12s ease}
.irl-mk-btn:hover{filter:brightness(1.12)}
.irl-mk-btn:active{transform:scale(.97)}
.irl-mk-btn:disabled{opacity:.5;cursor:not-allowed}
.irl-mk-btn.primary{flex:1;border:none;background:linear-gradient(135deg,#38bdf8,#6366f1);box-shadow:0 6px 20px rgba(56,189,248,.4)}
.irl-mk-btn.is-flash{animation:irlMkFlash .4s ease}
@keyframes irlMkFlash{0%{transform:scale(1)}40%{transform:scale(.92)}100%{transform:scale(1)}}
.irl-mk-btn:focus-visible{outline:2px solid #6366f1;outline-offset:2px}
.irl-mk-badge{position:fixed;left:50%;top:72px;transform:translateX(-50%);z-index:7;display:none;align-items:center;gap:7px;
  pointer-events:auto;background:rgba(8,8,16,.7);border:1px solid rgba(56,189,248,.5);border-radius:999px;
  padding:6px 13px;font-size:13px;font-weight:600;backdrop-filter:blur(8px);color:#fff}
.irl-mk-badge.is-shown{display:flex}
.irl-mk-badge .dot{width:7px;height:7px;border-radius:50%;background:#38bdf8;box-shadow:0 0 7px #38bdf8}
.irl-mk-sheet{position:fixed;inset:0;z-index:10;display:none;align-items:center;justify-content:center;padding:24px;
  background:rgba(4,4,10,.72);backdrop-filter:blur(10px)}
.irl-mk-sheet.is-open{display:flex}
.irl-mk-card{width:min(360px,92vw);background:#0c0c16;border:1px solid rgba(255,255,255,.12);border-radius:20px;
  padding:22px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.55)}
.irl-mk-card h3{margin:0 0 6px;font-size:18px}
.irl-mk-card p{margin:0 0 16px;font-size:13.5px;line-height:1.5;color:rgba(255,255,255,.72)}
.irl-mk-qr{width:240px;height:240px;margin:0 auto 16px;background:#fff;border-radius:14px;padding:14px;box-sizing:border-box}
.irl-mk-qr canvas,.irl-mk-qr img{width:100%;height:100%;display:block;image-rendering:pixelated}
.irl-mk-card-actions{display:flex;gap:10px}
@media (prefers-reduced-motion:reduce){.irl-mk-btn.is-flash{animation:none}}
`;
	const style = document.createElement('style');
	style.setAttribute('data-irl-marker-mode', '');
	style.textContent = css;
	document.head.appendChild(style);
}

/**
 * Wire the marker authoring/finding mode.
 *
 * @param {object} deps
 * @param {Element|null} deps.controlRow
 * @param {() => Promise<boolean>} deps.ensureReady    turn on camera AR; resolve true when usable
 * @param {() => HTMLVideoElement} deps.getVideo       the camera passthrough element (for detection)
 * @param {() => {lat:number,lng:number,ready:boolean,accuracy:number}} deps.getFix
 * @param {(picked:{cornerPoints:Array<{x,y}>, frame:{w,h}, spanPx:number}) => ({markerWorld:{x,z},markerY:number,markerYawDeg:number,distanceM:number}|null)} deps.observeMarker
 * @param {(roomId:string|null, obs:object|null) => void} deps.setLiveMarker   publish the live marker frame for the render path
 * @param {() => ({x:number,z:number,y:number})} deps.getViewerWorld          viewer's world position (for "place where I stand")
 * @param {(body:object) => Promise<{ok:boolean,id?:string,message?:string}>} deps.placeMarkerAgent
 * @param {(roomId:string) => Promise<{count:number}>} deps.loadMarkerRoom    fetch + spawn the marker room's pins
 * @param {(msg:string, opts?:object) => void} [deps.status]
 * @returns {{ isActive:()=>boolean, exit:()=>void }}
 */
export function initMarkerMode(deps) {
	const {
		ensureReady, getVideo, getFix, observeMarker,
		setLiveMarker, getViewerWorld, placeMarkerAgent, loadMarkerRoom,
	} = deps;
	const status = deps.status || (() => {});
	for (const [k, v] of Object.entries({ ensureReady, getVideo, observeMarker, setLiveMarker, getViewerWorld, placeMarkerAgent, loadMarkerRoom })) {
		if (typeof v !== 'function') throw new Error(`initMarkerMode: ${k} dep is required`);
	}
	injectStyles();

	let active = false;
	let scanner = null;
	let lockToken = null;        // canonical payload of the currently locked marker
	let lockRoomId = null;
	let lockObs = null;          // latest world observation of the locked marker
	let pendingToken = null;     // payload seen this streak
	let pendingCount = 0;
	let placedCount = 0;
	let busy = false;

	// ── Entry button ─────────────────────────────────────────────────────────
	const fab = document.createElement('button');
	fab.type = 'button';
	fab.className = 'irl-pill-btn irl-marker-fab';
	fab.setAttribute('aria-pressed', 'false');
	fab.setAttribute('aria-label', 'Anchor an AI agent to a marker in your space');
	fab.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M20 20v.01M17 20h.01M20 14h.01"/></svg> Marker`;
	(deps.controlRow || document.body).appendChild(fab);
	fab.addEventListener('click', () => (active ? exit() : enter()));
	// Reveal the entry only where QR scanning actually works (Chrome/Android). On a
	// browser without BarcodeDetector (iOS Safari, Firefox) the marker path can't run,
	// so the button stays hidden rather than dead — same honesty as the WebXR-gated UI.
	fab.style.display = 'none';
	qrDetectionAvailable().then((ok) => { if (ok) fab.style.display = ''; }).catch(() => {});

	// ── Badge ────────────────────────────────────────────────────────────────
	const badge = document.createElement('div');
	badge.className = 'irl-mk-badge';
	badge.setAttribute('role', 'status');
	badge.setAttribute('aria-live', 'polite');
	document.body.appendChild(badge);

	// ── Scan HUD ─────────────────────────────────────────────────────────────
	const hud = document.createElement('div');
	hud.id = 'irl-marker-hud';
	hud.innerHTML = `
		<div class="irl-mk-frame" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon id="irl-mk-poly" points="" fill="rgba(56,189,248,.16)" stroke="#38bdf8" stroke-width="0.5" style="display:none"/></svg></div>
		<div class="irl-mk-recticle" aria-hidden="true"></div>
		<div class="irl-mk-panel" role="group" aria-label="Anchor to a marker">
			<p class="irl-mk-coach" id="irl-mk-coach">Point at a QR marker to anchor agents to this spot.</p>
			<div class="irl-mk-actions">
				<button type="button" class="irl-mk-btn primary" id="irl-mk-place" disabled>Place here</button>
				<button type="button" class="irl-mk-btn" id="irl-mk-make">Make a marker</button>
				<button type="button" class="irl-mk-btn" id="irl-mk-done">Done</button>
			</div>
		</div>`;
	document.body.appendChild(hud);
	const coach = hud.querySelector('#irl-mk-coach');
	const poly = hud.querySelector('#irl-mk-poly');
	const placeBtn = hud.querySelector('#irl-mk-place');
	const makeBtn = hud.querySelector('#irl-mk-make');
	const doneBtn = hud.querySelector('#irl-mk-done');

	// ── Marker-maker sheet ───────────────────────────────────────────────────
	const sheet = document.createElement('div');
	sheet.className = 'irl-mk-sheet';
	sheet.setAttribute('role', 'dialog');
	sheet.setAttribute('aria-modal', 'true');
	sheet.setAttribute('aria-label', 'Your marker');
	sheet.innerHTML = `
		<div class="irl-mk-card">
			<h3>Your marker</h3>
			<p>Print this, or show it on another screen, and stick it where you'll anchor agents. Both phones scan the same marker — no GPS needed.</p>
			<div class="irl-mk-qr" id="irl-mk-qr"></div>
			<div class="irl-mk-card-actions">
				<button type="button" class="irl-mk-btn primary" id="irl-mk-dl">Save image</button>
				<button type="button" class="irl-mk-btn" id="irl-mk-close">Close</button>
			</div>
		</div>`;
	document.body.appendChild(sheet);
	const qrHolder = sheet.querySelector('#irl-mk-qr');
	const dlBtn = sheet.querySelector('#irl-mk-dl');
	const closeBtn = sheet.querySelector('#irl-mk-close');
	let madeToken = null;

	placeBtn.addEventListener('click', placeHere);
	makeBtn.addEventListener('click', openMaker);
	doneBtn.addEventListener('click', exit);
	closeBtn.addEventListener('click', () => sheet.classList.remove('is-open'));
	dlBtn.addEventListener('click', downloadMarker);
	hud.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); exit(); } });
	sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); sheet.classList.remove('is-open'); } });

	function setCoach(text, tone) {
		coach.textContent = text;
		if (tone) coach.setAttribute('data-tone', tone); else coach.removeAttribute('data-tone');
	}
	function refreshBadge() {
		if (active && lockRoomId) {
			badge.innerHTML = `<span class="dot"></span> Marker locked · ${placedCount} placed`;
			badge.classList.add('is-shown');
		} else badge.classList.remove('is-shown');
	}

	// Draw the detected QR outline so the lock reads as deliberate, not magic. The
	// corner pixels are mapped to the 0–100 viewBox the overlay SVG uses.
	function drawOutline(corners, frame) {
		if (!corners || !frame) { poly.style.display = 'none'; return; }
		const pts = corners.map(c => `${(c.x / frame.w) * 100},${(c.y / frame.h) * 100}`).join(' ');
		poly.setAttribute('points', pts);
		poly.style.display = '';
	}

	function onMarker(picked) {
		if (!active) return;
		const token = normalizeMarkerPayload(picked.rawValue);
		if (!token) { return; } // a non-marker QR (someone's wifi code) — ignore quietly
		drawOutline(picked.cornerPoints, picked.frame);

		// Resolve the marker's world pose for THIS frame (camera→world is the dep's job).
		const obs = observeMarker(picked);
		if (!obs) { setCoach('Move a little closer and hold steady…', 'warn'); return; }

		if (token === lockToken) {
			// Already locked — just refresh the live frame so the render path tracks it.
			lockObs = obs;
			setLiveMarker(lockRoomId, obs);
			return;
		}
		// Building a fresh lock: require a few agreeing frames so a fleeting glimpse
		// of a QR across the room doesn't yank the origin.
		if (token === pendingToken) pendingCount++;
		else { pendingToken = token; pendingCount = 1; }
		if (pendingCount < STABLE_LOCK_FRAMES) {
			setCoach('Marker found — hold steady to lock…', 'ok');
			return;
		}
		commitLock(token, obs);
	}

	function onIdle() {
		if (!active) return;
		drawOutline(null, null);
		if (!lockToken) {
			pendingToken = null; pendingCount = 0;
			setCoach('Point at a QR marker to anchor agents to this spot.');
		}
	}

	async function commitLock(token, obs) {
		lockToken = token;
		lockRoomId = markerRoomId(token);
		lockObs = obs;
		hud.classList.add('irl-mk-hud-locked');
		setLiveMarker(lockRoomId, obs);
		placeBtn.disabled = false;
		setCoach('Locked. Walk to a spot and tap “Place here”.', 'ok');
		try { navigator.vibrate && navigator.vibrate(12); } catch {}
		refreshBadge();
		// Pull anyone else's agents anchored to this marker and spawn them.
		try {
			const { count } = await loadMarkerRoom(lockRoomId);
			if (count > 0) setCoach(`Locked — ${count} agent${count === 1 ? '' : 's'} already here. Look around, or place your own.`, 'ok');
		} catch { /* a failed room read is non-fatal: placing still works */ }
	}

	async function placeHere() {
		if (busy || !lockRoomId || !lockObs) return;
		const fix = getFix ? getFix() : { ready: false };
		const viewer = getViewerWorld();
		busy = true;
		placeBtn.disabled = true;
		const prev = placeBtn.textContent;
		placeBtn.textContent = 'Placing…';
		let result;
		try {
			result = await placeMarkerAgent({
				roomId: lockRoomId,
				token: lockToken,
				marker: lockObs,
				viewer,
				fix,
			});
		} catch { result = { ok: false, message: 'Network error — try again.' }; }
		busy = false;
		placeBtn.textContent = prev;
		placeBtn.disabled = false;
		if (result && result.ok) {
			placedCount++;
			refreshBadge();
			placeBtn.classList.remove('is-flash'); void placeBtn.offsetWidth; placeBtn.classList.add('is-flash');
			setCoach('Placed. It’s standing where you are — walk away and look back.', 'ok');
			try { navigator.vibrate && navigator.vibrate(10); } catch {}
		} else {
			setCoach(result?.message || 'Could not place the agent — try again.', 'warn');
		}
	}

	async function openMaker() {
		madeToken = randomToken();
		qrHolder.innerHTML = '';
		sheet.classList.add('is-open');
		closeBtn.focus();
		try {
			const mod = await import('qrcode');
			const QR = mod.default ?? mod; // CJS/ESM interop: qrcode ships CommonJS
			const canvas = document.createElement('canvas');
			await QR.toCanvas(canvas, markerUrl(madeToken), { width: 240, margin: 1, errorCorrectionLevel: 'M' });
			qrHolder.appendChild(canvas);
		} catch {
			// Library unavailable — fall back to a link the user can open on the other
			// phone, which lands on the same marker token via the ?m= deep link.
			qrHolder.innerHTML = `<p style="color:#111;font-size:12px;word-break:break-all;padding:8px">${markerUrl(madeToken)}</p>`;
		}
	}

	async function downloadMarker() {
		if (!madeToken) return;
		const canvas = qrHolder.querySelector('canvas');
		const finish = (url) => {
			const a = document.createElement('a');
			a.href = url; a.download = `three-ws-marker-${madeToken}.png`; a.click();
		};
		if (canvas) { finish(canvas.toDataURL('image/png')); return; }
		try {
			const mod = await import('qrcode');
			const QR = mod.default ?? mod;
			finish(await QR.toDataURL(markerUrl(madeToken), { width: 512, margin: 2 }));
		} catch { status('Could not generate the marker image.', { warn: true }); }
	}

	async function enter() {
		if (active) return;
		let ok = false;
		try { ok = await ensureReady(); } catch { ok = false; }
		if (!ok) { status('Turn on the camera to scan a marker.', { warn: true }); return; }
		if (!(await qrDetectionAvailable())) {
			status('This browser can’t scan QR markers. Open /irl in Chrome on Android to use markers.', { warn: true, sticky: true });
			return;
		}
		active = true;
		busy = false;
		lockToken = lockRoomId = lockObs = null;
		pendingToken = null; pendingCount = 0;
		document.body.classList.add('irl-marker-mode');
		fab.setAttribute('aria-pressed', 'true');
		fab.classList.add('is-active');
		hud.classList.add('is-open');
		hud.classList.remove('irl-mk-hud-locked');
		placeBtn.disabled = true;
		setCoach('Point at a QR marker to anchor agents to this spot.');
		makeBtn.focus();
		scanner = startQrScanLoop({ video: getVideo(), onMarker, onIdle });
	}

	function exit() {
		if (!active) return;
		active = false;
		scanner?.stop();
		scanner = null;
		setLiveMarker(null, null); // stop rendering against a marker we're no longer tracking
		document.body.classList.remove('irl-marker-mode');
		fab.setAttribute('aria-pressed', 'false');
		fab.classList.remove('is-active');
		hud.classList.remove('is-open', 'irl-mk-hud-locked');
		badge.classList.remove('is-shown');
		sheet.classList.remove('is-open');
		drawOutline(null, null);
	}

	return { isActive: () => active, exit };
}
