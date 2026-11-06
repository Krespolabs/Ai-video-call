// Shared WebGL availability preflight + guarded renderer factory.
//
// Every 3D surface on three.ws constructs a `THREE.WebGLRenderer`. That
// constructor THROWS — `Error: Error creating WebGL context.` — whenever the
// browser can't grant a WebGL/WebGL2 context: no GPU, a driver on the browser's
// blocklist, a headless/automation UA, or (most commonly on mobile Safari) the
// per-tab live-context budget already spent by other canvases on the page. An
// unguarded `new WebGLRenderer()` therefore crashes the whole entry module — for
// the many surfaces that build the renderer at module top-level, that blanks the
// entire page on import.
//
// This module centralises the two things every surface needs:
//   1. `isWebGLAvailable()` — a cheap, cached probe that creates a throwaway
//      context, confirms it's real, and immediately releases it so the probe
//      never counts against the browser's context budget. Mirrors the canonical
//      probe in app.js (`_webglAvailable`).
//   2. `createRenderer(opts, { fallback })` — preflights, then constructs the
//      renderer inside a try/catch. On either the preflight failing OR the
//      constructor throwing, it mounts a designed "3D unavailable" panel in the
//      given container and throws a typed `WebGLUnavailableError`. Callers in an
//      init function catch it and bail to their fallback UI; callers that build
//      at module top-level let it propagate — the throw halts the rest of that
//      module's initialisation cleanly (so no cascade of "renderer is undefined"
//      secondary errors) and the error reporter recognises the typed signal as a
//      benign device limitation and suppresses it (public/error-reporter.js).
//
// The net effect: no 3D surface can white-screen or spam the console on a device
// that simply can't do WebGL — it shows a friendly, on-brand fallback instead.

import { WebGLRenderer } from 'three';

let _cached;

// Cached WebGL-capability probe. Creates a context, verifies it's usable, then
// releases it via WEBGL_lose_context so the probe itself doesn't consume one of
// the browser's scarce live contexts.
export function isWebGLAvailable() {
	if (typeof _cached === 'boolean') return _cached;
	let ok = false;
	try {
		const canvas = document.createElement('canvas');
		const gl =
			canvas.getContext('webgl2') ||
			canvas.getContext('webgl') ||
			canvas.getContext('experimental-webgl');
		ok = !!(window.WebGLRenderingContext && gl && typeof gl.getParameter === 'function');
		const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
		if (lose) lose.loseContext();
	} catch {
		ok = false;
	}
	_cached = ok;
	return ok;
}

// Typed, expected signal that a surface could not start WebGL on this device.
// It is NOT a code bug — it is a device/browser capability limit — so the error
// reporter suppresses it by name/message (see IGNORED_WEBGL in error-reporter).
export class WebGLUnavailableError extends Error {
	constructor(cause) {
		super('webgl_unavailable');
		this.name = 'WebGLUnavailableError';
		this.webglUnavailable = true;
		if (cause !== undefined) this.cause = cause;
	}
}

// Mount a designed, dependency-free "3D unavailable" panel into `target` (an
// element, or a canvas whose parent will host the panel). Idempotent: it won't
// stack multiple panels, and it hides the dead canvas so the layout doesn't show
// a blank rectangle. Safe to call with a missing target (no-op).
export function mountWebglFallback(target, { title, hint } = {}) {
	try {
		let host = target;
		if (host && host.tagName === 'CANVAS') {
			host.style.display = 'none';
			host = host.parentElement || document.body;
		}
		if (!host) return;
		if (host.querySelector?.(':scope > .webgl-fallback')) return; // already shown

		const panel = document.createElement('div');
		panel.className = 'webgl-fallback';
		panel.setAttribute('role', 'status');
		panel.style.cssText = [
			'display:flex', 'flex-direction:column', 'align-items:center',
			'justify-content:center', 'gap:10px', 'min-height:180px', 'width:100%',
			'padding:32px 24px', 'box-sizing:border-box', 'text-align:center',
			'font-family:Inter,system-ui,sans-serif', 'color:#cdd3e0',
			'background:radial-gradient(120% 120% at 50% 0%,#161a24 0%,#0b0d13 70%)',
			'border-radius:14px',
		].join(';');
		panel.innerHTML = `
			<div aria-hidden="true" style="font-size:30px;line-height:1;opacity:.85">◆</div>
			<div style="font-size:15px;font-weight:600;color:#eef1f7">${
				title || '3D preview unavailable'
			}</div>
			<div style="font-size:12.5px;line-height:1.5;max-width:340px;color:#9aa3b4">${
				hint ||
				"This browser or device couldn't start a 3D (WebGL) view. Try reloading, or open three.ws on a device with hardware graphics enabled."
			}</div>`;
		host.appendChild(panel);
	} catch {
		/* a fallback that throws would defeat its own purpose — never propagate. */
	}
}

/**
 * Construct a WebGLRenderer with a guaranteed-graceful failure path.
 *
 * @param {object} options            Passed straight to `new WebGLRenderer(options)`.
 * @param {{ fallback?: Element }} [guard]  Container to mount the fallback panel into
 *                                          when WebGL is unavailable.
 * @returns {import('three').WebGLRenderer}
 * @throws {WebGLUnavailableError} when WebGL is unavailable or the context fails.
 */
export function createRenderer(options = {}, { fallback } = {}) {
	if (!isWebGLAvailable()) {
		mountWebglFallback(fallback);
		throw new WebGLUnavailableError();
	}
	try {
		return new WebGLRenderer(options);
	} catch (err) {
		mountWebglFallback(fallback);
		throw new WebGLUnavailableError(err);
	}
}
