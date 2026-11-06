// src/irl/glasses/connect-ui.js — the "Connect glasses" surface for /irl.
//
// One designed, reachable sheet that pairs companion smart glasses to the live /irl
// session over Web Bluetooth and mirrors the nearest-agent HUD to the lens. Every
// state is built: an honest capability gate (Web Bluetooth is Chromium-only — no iOS
// Safari), a device picker, a real async connecting state (no fake progress bar), the
// G1's two-arm staged pairing, a connected view with a live preview of what's on the
// lens, and an error state with retry. Visual language matches privacy-center.js
// (dark bottom-sheet, blue accent) with an `irlg-` namespace.

import { GLASSES_DEVICES, GlassesBridge } from './bridge.js';
import { FrameGlasses } from './frame.js';
import { G1Glasses } from './g1.js';

const STYLE_ID = 'irlg-styles';

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = `
.irlg-root{position:fixed;inset:0;z-index:10001;display:flex;align-items:flex-end;justify-content:center}
.irlg-back{position:absolute;inset:0;background:rgba(4,6,12,.62);backdrop-filter:blur(2px);animation:irlg-fade .2s ease}
.irlg-sheet{position:relative;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;background:#0c0f17;
  border:1px solid #232838;border-bottom:none;border-radius:18px 18px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.55);
  animation:irlg-rise .26s cubic-bezier(.2,.8,.2,1)}
@media(min-width:600px){.irlg-root{align-items:center}.irlg-sheet{border-radius:18px;border-bottom:1px solid #232838}}
@keyframes irlg-rise{from{transform:translateY(14px);opacity:.4}to{transform:translateY(0);opacity:1}}
@keyframes irlg-fade{from{opacity:0}to{opacity:1}}
.irlg-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 6px}
.irlg-title{font:600 16px/1.2 system-ui,sans-serif;color:#eef1f7;display:flex;align-items:center;gap:9px}
.irlg-title svg{color:#7aa2ff}
.irlg-x{appearance:none;background:none;border:none;color:#8b93a7;font-size:24px;line-height:1;cursor:pointer;
  width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
.irlg-x:hover,.irlg-x:focus-visible{background:#1a1f2e;color:#eef1f7;outline:none}
.irlg-sec{padding:12px 18px}
.irlg-lead{font:400 13px/1.5 system-ui,sans-serif;color:#aeb6c8;margin:0 0 6px}
.irlg-card{display:flex;align-items:center;gap:13px;width:100%;text-align:left;appearance:none;cursor:pointer;
  background:#11151f;border:1px solid #232838;border-radius:13px;padding:14px;margin-top:10px;transition:background .15s,border-color .15s,transform .1s}
.irlg-card:hover{background:#1a2032;border-color:#34406a}
.irlg-card:active{transform:scale(.99)}
.irlg-card:focus-visible{outline:2px solid #4f7cff;outline-offset:2px}
.irlg-card .ic{width:40px;height:40px;flex-shrink:0;border-radius:10px;display:flex;align-items:center;justify-content:center;
  background:#0a0d14;border:1px solid #232838;color:#7aa2ff}
.irlg-card .meta{flex:1;min-width:0}
.irlg-card .nm{font:600 14px/1.25 system-ui,sans-serif;color:#eef1f7;display:flex;align-items:center;gap:7px}
.irlg-card .sub{font:400 11.5px/1.35 system-ui,sans-serif;color:#8b93a7;margin-top:3px}
.irlg-card .ar{color:#8b93a7;font-size:19px;flex-shrink:0}
.irlg-exp{font:600 9px/1.4 system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#cda13a;
  background:#2a2410;border:1px solid #4a3f17;border-radius:5px;padding:1px 5px}
.irlg-note{margin-top:12px;font:400 11.5px/1.5 system-ui,sans-serif;color:#7b8398}
.irlg-spin{width:34px;height:34px;border-radius:50%;border:3px solid #232838;border-top-color:#4f7cff;
  animation:irlg-spin .9s linear infinite;margin:6px auto 14px}
@keyframes irlg-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.irlg-spin{animation-duration:2s}}
.irlg-status{text-align:center;padding:18px 12px}
.irlg-status .st{font:600 14px/1.3 system-ui,sans-serif;color:#eef1f7;margin-bottom:5px}
.irlg-status .sd{font:400 12.5px/1.5 system-ui,sans-serif;color:#8b93a7}
.irlg-steps{list-style:none;margin:14px 0 0;padding:0}
.irlg-step{display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid #232838;border-radius:11px;margin-bottom:9px;background:#11151f}
.irlg-step .dot{width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  border:2px solid #2a3042;color:#8b93a7;font:600 11px system-ui,sans-serif}
.irlg-step.done .dot{background:#34c759;border-color:#34c759;color:#06210f}
.irlg-step.active .dot{border-color:#4f7cff;color:#7aa2ff}
.irlg-step .lb{flex:1;font:600 13px/1.25 system-ui,sans-serif;color:#eef1f7}
.irlg-step .lb small{display:block;font-weight:400;font-size:11px;color:#8b93a7;margin-top:2px}
.irlg-step button{appearance:none;background:#4f7cff;color:#fff;border:none;border-radius:9px;padding:9px 14px;
  font:600 12.5px system-ui,sans-serif;cursor:pointer;transition:background .15s;flex-shrink:0}
.irlg-step button:hover{background:#3d6af0}
.irlg-step button:disabled{opacity:.5;cursor:default}
.irlg-lens{margin:4px auto 0;max-width:340px;background:#05070c;border:1px solid #232838;border-radius:13px;
  padding:18px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.irlg-lens.g1{background:#04130a;border-color:#0f3a1f}
.irlg-lens .ll{font-size:15px;line-height:1.7;color:#dfe6f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.7em}
.irlg-lens.g1 .ll{color:#67f6a3;text-shadow:0 0 8px rgba(70,240,140,.45)}
.irlg-lens .ll.l0{font-size:18px;font-weight:600}
.irlg-lens .ll.dim{color:#5a6377}
.irlg-lens.g1 .ll.dim{color:#2f7a4c}
.irlg-caption{text-align:center;font:400 11px/1.4 system-ui,sans-serif;color:#7b8398;margin-top:9px}
.irlg-connpill{display:inline-flex;align-items:center;gap:7px;font:600 12px system-ui,sans-serif;color:#34c759;
  background:#0f2417;border:1px solid #1f6b3a;border-radius:999px;padding:6px 12px}
.irlg-connpill::before{content:'';width:8px;height:8px;border-radius:50%;background:#34c759;box-shadow:0 0 7px #34c759}
.irlg-foot{padding:14px 18px 18px;display:flex;flex-direction:column;gap:9px}
.irlg-btn{width:100%;appearance:none;border-radius:11px;font:600 14px system-ui,sans-serif;padding:13px;cursor:pointer;transition:background .15s,border-color .15s}
.irlg-btn.primary{background:#4f7cff;color:#fff;border:none}
.irlg-btn.primary:hover{background:#3d6af0}
.irlg-btn.ghost{background:#11151f;border:1px solid #232838;color:#eef1f7}
.irlg-btn.ghost:hover{background:#1a2032}
.irlg-btn.danger{background:#1c1014;border:1px solid #4a2630;color:#ff9a9a}
.irlg-btn.danger:hover{background:#2a1620;border-color:#6a3340;color:#ffb3b3}
.irlg-err{background:#1c1014;border:1px solid #4a2630;border-radius:11px;padding:13px 14px;color:#ffb3b3;
  font:500 12.5px/1.5 system-ui,sans-serif}
.irlg-gate{text-align:center;padding:8px 6px 4px}
.irlg-gate .gic{font-size:30px;display:block;margin-bottom:10px}
.irlg-gate .gt{font:600 15px/1.3 system-ui,sans-serif;color:#eef1f7;margin-bottom:7px}
.irlg-gate .gb{font:400 13px/1.55 system-ui,sans-serif;color:#aeb6c8;max-width:380px;margin:0 auto}
.irlg-gate .gb b{color:#dfe6f5}
`;
	document.head.appendChild(el);
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const GLASSES_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="15" r="4"/><circle cx="18" cy="15" r="4"/><path d="M10 15a2 2 0 0 1 4 0"/><path d="m2.5 13 1.5-5a2 2 0 0 1 2-1.5"/><path d="m21.5 13-1.5-5a2 2 0 0 0-2-1.5"/></svg>';

function deviceIcon(Dev) {
	return Dev.id === 'g1'
		? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="14" r="3.4"/><circle cx="18" cy="14" r="3.4"/><path d="M9.4 14a2.6 2.6 0 0 1 5.2 0"/></svg>'
		: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="3"/><path d="M7 11h2M15 11h2"/></svg>';
}

// Generic modal shell (backdrop + Esc + focus return), matching privacy-center.
// `onClose` runs on EVERY dismissal path (backdrop, Esc, or a [data-close] button) so
// callers can tear down timers/subscriptions without re-wiring each path.
function modal(buildInner, onClose) {
	ensureStyles();
	const root = document.createElement('div');
	root.className = 'irlg-root';
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-modal', 'true');
	root.setAttribute('aria-label', 'Connect smart glasses');
	const back = document.createElement('div');
	back.className = 'irlg-back';
	const sheet = document.createElement('div');
	sheet.className = 'irlg-sheet';
	root.append(back, sheet);
	document.body.appendChild(root);
	const prevOverflow = document.body.style.overflow;
	document.body.style.overflow = 'hidden';
	const prevFocus = document.activeElement;

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener('keydown', onKey, true);
		root.remove();
		document.body.style.overflow = prevOverflow;
		try { onClose?.(); } catch { /* teardown best-effort */ }
		try { prevFocus?.focus?.(); } catch { /* element gone */ }
	};
	const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
	document.addEventListener('keydown', onKey, true);
	back.addEventListener('click', close);
	buildInner(sheet, close);
	return close;
}

function head(title) {
	return `<div class="irlg-head"><div class="irlg-title">${GLASSES_SVG}<span>${esc(title)}</span></div>
		<button class="irlg-x" type="button" data-close aria-label="Close">×</button></div>`;
}

/**
 * Open the Connect-glasses sheet.
 * @param {GlassesBridge} bridge the live bridge instance from irl.js
 */
export function openGlassesConnect(bridge) {
	let previewTimer = null;
	let unsub = null;
	let g1 = null; // staged G1 adapter across the two-arm flow
	const stopPreview = () => { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } };
	// Runs on every dismissal (backdrop / Esc / Close button) via modal()'s onClose.
	const teardown = () => { stopPreview(); if (unsub) { unsub(); unsub = null; } };

	modal((sheet, close) => {
		const wireClose = () => sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));

		const isCancel = (e) => e && (e.name === 'NotFoundError' || e.name === 'AbortError');

		// React to a link drop while the sheet is open (arm out of range, battery dead).
		unsub = bridge.on('status', ({ status }) => {
			if (status === 'error' && !sheet.querySelector('[data-err]')) {
				renderError(bridge.error || 'The glasses disconnected.', () => renderPicker());
			}
		});

		// ── Capability gate ──────────────────────────────────────────────────────
		function renderGate(reason) {
			stopPreview();
			const copy = reason === 'ios'
				? { ic: '📵', t: 'Glasses pairing isn’t available on iOS', b: 'Apple’s browser engine has no Web Bluetooth, so iPhone and iPad can’t pair glasses directly. Open <b>three.ws/irl in Chrome on an Android phone</b> to connect Frame or G1 — the AR view still works here.' }
				: reason === 'insecure'
					? { ic: '🔒', t: 'A secure connection is required', b: 'Web Bluetooth only runs over <b>HTTPS</b>. Open the live <b>three.ws/irl</b> (not a plain-http preview) and try again.' }
					: { ic: '🖥️', t: 'This browser can’t pair glasses', b: 'Pairing uses <b>Web Bluetooth</b>, available in Chrome, Edge and other Chromium browsers. The AR view works everywhere — glasses just need a Chromium browser.' };
			sheet.innerHTML = `${head('Connect glasses')}
				<div class="irlg-sec"><div class="irlg-gate">
					<span class="gic">${copy.ic}</span>
					<div class="gt">${esc(copy.t)}</div>
					<div class="gb">${copy.b}</div>
				</div></div>
				<div class="irlg-foot"><button class="irlg-btn ghost" type="button" data-close>Close</button></div>`;
			wireClose();
		}

		// ── Device picker ────────────────────────────────────────────────────────
		function renderPicker() {
			stopPreview();
			const cards = GLASSES_DEVICES.map((Dev) => `
				<button class="irlg-card" type="button" data-dev="${Dev.id}">
					<span class="ic">${deviceIcon(Dev)}</span>
					<span class="meta">
						<span class="nm">${esc(Dev.label)}${Dev.experimental ? '<span class="irlg-exp">Experimental</span>' : ''}</span>
						<span class="sub">${esc(Dev.tagline || '')}</span>
					</span>
					<span class="ar" aria-hidden="true">→</span>
				</button>`).join('');
			sheet.innerHTML = `${head('Connect glasses')}
				<div class="irlg-sec">
					<p class="irlg-lead">Mirror the nearest agent — direction, distance and arrivals — onto your glasses. Your phone keeps doing the GPS, compass and discovery; the lens just shows the cue.</p>
					${cards}
					<p class="irlg-note">Pairing uses Web Bluetooth over an encrypted link. We never send your location to the glasses — only the on-screen direction and distance you already see.</p>
				</div>
				<div class="irlg-foot"><button class="irlg-btn ghost" type="button" data-close>Close</button></div>`;
			wireClose();
			sheet.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => {
				if (b.dataset.dev === 'g1') startG1();
				else connectFrame();
			}));
		}

		function renderConnecting(label, detail) {
			sheet.innerHTML = `${head('Connecting')}
				<div class="irlg-sec"><div class="irlg-status">
					<div class="irlg-spin" aria-hidden="true"></div>
					<div class="st">${esc(label)}</div>
					<div class="sd">${esc(detail)}</div>
				</div></div>`;
			// No close-to-cancel mid-chooser; the browser prompt owns that. A backdrop
			// click still closes the sheet.
		}

		function renderError(message, retry) {
			stopPreview();
			sheet.innerHTML = `${head('Couldn’t connect')}
				<div class="irlg-sec">
					<div class="irlg-err" data-err>${esc(message)}</div>
				</div>
				<div class="irlg-foot">
					<button class="irlg-btn primary" type="button" data-retry>Try again</button>
					<button class="irlg-btn ghost" type="button" data-back>Choose a different device</button>
				</div>`;
			sheet.querySelector('[data-retry]')?.addEventListener('click', () => retry());
			sheet.querySelector('[data-back]')?.addEventListener('click', () => renderPicker());
			sheet.querySelector('[data-close]')?.addEventListener('click', close);
		}

		// ── Connected — live lens preview ─────────────────────────────────────────
		function renderConnected() {
			stopPreview();
			const isG1 = bridge.adapter instanceof G1Glasses;
			sheet.innerHTML = `${head('Glasses connected')}
				<div class="irlg-sec">
					<div style="text-align:center;margin-bottom:14px"><span class="irlg-connpill">${esc(bridge.deviceName || 'Connected')}</span></div>
					<div class="irlg-lens ${isG1 ? 'g1' : ''}" data-lens aria-live="off">
						<div class="ll l0" data-l0></div>
						<div class="ll" data-l1></div>
						<div class="ll" data-l2></div>
					</div>
					<p class="irlg-caption">Live preview of what’s on your lens — updates as you move.</p>
				</div>
				<div class="irlg-foot"><button class="irlg-btn danger" type="button" data-disc>Disconnect glasses</button></div>`;
			wireClose();
			sheet.querySelector('[data-disc]')?.addEventListener('click', async () => {
				const btn = sheet.querySelector('[data-disc]');
				if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
				await bridge.disconnect();
				renderPicker();
			});
			const paint = () => {
				const m = bridge.lastModel;
				const lines = (m?.lines || [' ', ' ', ' ']).map((l) => (l === ' ' ? '' : l));
				const set = (sel, txt) => {
					const elx = sheet.querySelector(sel);
					if (!elx) return;
					elx.textContent = txt || '—';
					elx.classList.toggle('dim', !txt);
				};
				set('[data-l0]', lines[0]);
				set('[data-l1]', lines[1]);
				set('[data-l2]', lines[2]);
			};
			paint();
			previewTimer = setInterval(paint, 400);
		}

		// ── Frame: single-step connect ────────────────────────────────────────────
		async function connectFrame() {
			const adapter = new FrameGlasses();
			bridge._setConnecting();
			renderConnecting(FrameGlasses.label, 'Pick your Frame in the browser prompt…');
			try {
				await adapter.request();
				renderConnecting(FrameGlasses.label, 'Linking up…');
				await adapter.connect();
				bridge.attach(adapter);
				renderConnected();
			} catch (e) {
				if (isCancel(e)) { renderPicker(); return; }
				bridge._setStatus('error', e?.message || 'connect failed');
				renderError(friendly(e), connectFrame);
			}
		}

		// ── G1: two-arm staged connect ────────────────────────────────────────────
		function startG1() {
			g1 = new G1Glasses();
			renderG1Staged();
		}

		function renderG1Staged() {
			stopPreview();
			const leftDone = !!g1?.ports.left?.connected;
			const rightDone = !!g1?.ports.right?.connected;
			const stepHTML = (n, side, label, done, active) => `
				<li class="irlg-step ${done ? 'done' : ''} ${active ? 'active' : ''}">
					<span class="dot">${done ? '✓' : n}</span>
					<span class="lb">${esc(label)}<small>${done ? 'Paired' : active ? 'Select this arm in the prompt' : 'Pair the previous arm first'}</small></span>
					${done ? '' : `<button type="button" data-arm="${side}" ${active ? '' : 'disabled'}>Pair</button>`}
				</li>`;
			sheet.innerHTML = `${head('Pair Even Realities G1')}
				<div class="irlg-sec">
					<p class="irlg-lead">The G1’s two arms pair as separate Bluetooth devices — connect the left, then the right.</p>
					<ul class="irlg-steps">
						${stepHTML(1, 'left', 'Left arm', leftDone, !leftDone)}
						${stepHTML(2, 'right', 'Right arm', rightDone, leftDone && !rightDone)}
					</ul>
					<p class="irlg-note">Experimental: the G1 has no official SDK, so this uses the community-documented protocol. Direction and distance render as green text.</p>
				</div>
				<div class="irlg-foot"><button class="irlg-btn ghost" type="button" data-back>Back</button></div>`;
			sheet.querySelector('[data-back]')?.addEventListener('click', () => renderPicker());
			sheet.querySelectorAll('[data-arm]').forEach((b) => b.addEventListener('click', () => connectG1Arm(b.dataset.arm)));
		}

		async function connectG1Arm(side) {
			renderConnecting(G1Glasses.label, side === 'left' ? 'Select the LEFT arm in the prompt…' : 'Select the RIGHT arm in the prompt…');
			try {
				await g1.requestArm(side, { onClose: (reason) => bridge._setStatus('error', reason || 'disconnected') });
				if (g1.connected) {
					bridge.attach(g1);
					renderConnected();
				} else {
					renderG1Staged();
				}
			} catch (e) {
				if (isCancel(e)) { renderG1Staged(); return; }
				renderError(friendly(e), () => renderG1Staged());
			}
		}

		function friendly(e) {
			const msg = e?.message || String(e || '');
			if (e?.name === 'SecurityError') return 'The browser blocked the Bluetooth request. Make sure the page is served over HTTPS and try again.';
			if (e?.name === 'NetworkError') return 'Lost the connection to the glasses. Bring them closer and try again.';
			if (/User cancelled|chooser/i.test(msg)) return 'Pairing was cancelled. Tap a device to try again.';
			return msg || 'Something went wrong while connecting. Try again.';
		}

		// Initial view: already connected → preview; otherwise gate or picker.
		const support = GlassesBridge.support();
		if (bridge.connected) renderConnected();
		else if (!support.supported) renderGate(support.reason);
		else renderPicker();
	}, teardown);
}
