// Fake WebXR device layer for driving src/ar/webxr.js without AR hardware.
//
// WebXR is the one browser API a headless browser can't drive: immersive-ar
// needs a real camera, a real IMU, and a real compositor, so the floor-anchor
// session would otherwise only ever be "tested on one Android phone." That means
// every unhappy path — anchor creation rejecting, tracking dropping, the OS
// ending the session — ships unverified.
//
// This harness stands in for exactly the XR device layer and nothing else:
//   • a fake `navigator.xr` (requestSession / isSessionSupported),
//   • a fake XRSession that records listeners and lets a test fire
//     select / visibilitychange / end,
//   • scriptable XRFrame / XRHitTestResult / XRAnchor so a test feeds a precise
//     sequence of poses (no-hit → hit at a known matrix → anchored), and
//   • a renderer stub whose setAnimationLoop hands the per-frame tick back to the
//     test to step by hand.
//
// Three.js stays REAL everywhere it's cheap — the reticle Mesh, the Scene, the
// content group, the XR camera — because that code path (geometry, scene.add,
// matrix decompose) is worth exercising for real. Only the GPU renderer and the
// XR device are faked. Consumed by tests/ar-webxr-session.test.js.

import { Matrix4, Object3D, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';

// ── A tiny EventTarget the XRSession shims share ─────────────────────────────
// Real XRSession dispatches DOM-style events; webxr.js only ever uses
// addEventListener / removeEventListener with bare handlers. We keep our own
// registry (rather than node's EventTarget) so a test can assert a listener was
// actually removed on teardown — the "stop listening before we tear down" promise.
class Emitter {
	constructor() {
		/** @type {Map<string, Set<Function>>} */
		this._listeners = new Map();
	}

	addEventListener(type, fn) {
		if (!this._listeners.has(type)) this._listeners.set(type, new Set());
		this._listeners.get(type).add(fn);
	}

	removeEventListener(type, fn) {
		this._listeners.get(type)?.delete(fn);
	}

	/** Number of live listeners for a type — lets tests prove teardown unsubscribed. */
	listenerCount(type) {
		return this._listeners.get(type)?.size ?? 0;
	}

	_dispatch(type, event = { type }) {
		// Copy first: a handler may remove itself (teardown does) mid-dispatch.
		for (const fn of [...(this._listeners.get(type) ?? [])]) fn(event);
	}
}

// ── XRAnchor ─────────────────────────────────────────────────────────────────
// A real anchor exposes `anchorSpace`, an opaque handle a frame resolves to a
// live pose. We make it a unique object so FakeXRFrame.getPose can key off it.
export class FakeXRAnchor {
	constructor() {
		this.anchorSpace = { __anchorSpace: true };
		this.deleted = false;
	}

	delete() {
		this.deleted = true;
	}
}

// ── XRHitTestResult ──────────────────────────────────────────────────────────
// Carries the surface matrix the reticle/content follow, and decides what
// createAnchor() does — the branch that separates a rock-solid anchor from the
// degraded frozen-pose fallback (task 05).
//
//   anchor: 'real'        → createAnchor resolves a FakeXRAnchor (happy path)
//   anchor: 'reject'      → createAnchor rejects (device advertises, can't honour)
//   anchor: 'unsupported' → createAnchor is absent entirely (older runtime)
export class FakeXRHitTestResult {
	constructor(matrix, { anchor = 'real' } = {}) {
		this._matrix = matrix instanceof Matrix4 ? matrix : new Matrix4().fromArray(matrix);
		this._anchorMode = anchor;
		/** @type {FakeXRAnchor|null} The anchor handed back by createAnchor, for the test. */
		this.createdAnchor = null;
		if (anchor !== 'unsupported') {
			this.createAnchor = async () => {
				if (this._anchorMode === 'reject') throw new Error('anchor creation failed');
				this.createdAnchor = new FakeXRAnchor();
				return this.createdAnchor;
			};
		}
	}

	getPose(/* referenceSpace */) {
		return { transform: { matrix: this._matrix.toArray() } };
	}
}

// ── XRFrame ──────────────────────────────────────────────────────────────────
// Scripted per-frame state. A test builds one of these and passes it to the
// renderer tick. Three knobs:
//   viewerPose : truthy → tracking healthy; null → tracking lost this frame.
//   hits       : array of FakeXRHitTestResult (empty/absent → reticle searches).
//   anchorPose : { anchor, position } → getPose(anchor.anchorSpace) yields position,
//                so an anchored agent can be driven frame-to-frame.
export class FakeXRFrame {
	constructor({ viewerPose = {}, hits = [], anchorPose = null } = {}) {
		this._viewerPose = viewerPose;
		this._hits = hits;
		this._anchorPose = anchorPose;
	}

	getViewerPose(/* space */) {
		return this._viewerPose;
	}

	getHitTestResults(/* source */) {
		return this._hits;
	}

	getPose(space /* , baseSpace */) {
		const a = this._anchorPose;
		if (a && a.anchor && space === a.anchor.anchorSpace) {
			const p = a.position;
			return { transform: { position: { x: p.x, y: p.y, z: p.z } } };
		}
		return null;
	}
}

// ── XRSession ────────────────────────────────────────────────────────────────
export class FakeXRSession extends Emitter {
	constructor(mode, init) {
		super();
		this.mode = mode;
		this.init = init;
		this.visibilityState = 'visible';
		this.ended = false;
		/** Hit-test sources handed out, so a test can assert cancel() ran on teardown. */
		this.hitTestSources = [];
	}

	async requestReferenceSpace(type) {
		return { __referenceSpace: type };
	}

	async requestHitTestSource({ space }) {
		const source = { space, cancelled: false, cancel() { this.cancelled = true; } };
		this.hitTestSources.push(source);
		return source;
	}

	async end() {
		// Real sessions fire 'end' asynchronously after end() resolves; webxr.js
		// relies on the event (not the promise) for teardown, so emit it here.
		if (this.ended) return;
		this.ended = true;
		this._dispatch('end');
	}

	// ── Test driver surface ──────────────────────────────────────────────────
	/** Fire a screen tap / controller trigger → WebXRSession._handleSelect. */
	emitSelect() {
		this._dispatch('select');
	}

	/** Move to a visibility state and fire visibilitychange (lock / call / switch). */
	emitVisibility(state) {
		this.visibilityState = state;
		this._dispatch('visibilitychange');
	}

	/** OS-initiated end (phone locked, app swiped away) — same path as end(). */
	emitEnd() {
		if (this.ended) return;
		this.ended = true;
		this._dispatch('end');
	}
}

// ── navigator.xr ───────────────────────────────────────────────────────────--
export class FakeXRSystem {
	constructor({ supported = true } = {}) {
		this._supported = supported;
		/** @type {FakeXRSession|null} The last session handed out. */
		this.session = null;
		/** Captured requestSession args, for asserting requiredFeatures/domOverlay. */
		this.lastInit = null;
	}

	async isSessionSupported(/* mode */) {
		return this._supported;
	}

	async requestSession(mode, init) {
		this.lastInit = init;
		this.session = new FakeXRSession(mode, init);
		return this.session;
	}
}

// ── Renderer stub ────────────────────────────────────────────────────────────
// Real WebGLRenderer needs a GL context; we stub the surface WebXRSession touches
// and capture the animation-loop callback so the test steps frames by hand.
export function createFakeRenderer() {
	const xrCamera = new PerspectiveCamera();
	const renderer = {
		xr: {
			enabled: false,
			_session: null,
			async setSession(session) { this._session = session; },
			getCamera() { return xrCamera; },
		},
		_animationLoop: null,
		clearColor: { color: 0x000000, alpha: 1 },
		renderCount: 0,
		setClearColor(color, alpha) { this.clearColor = { color, alpha }; },
		setAnimationLoop(fn) { this._animationLoop = fn; },
		render() { this.renderCount += 1; },
		/** Drive one XR frame exactly as the browser's XR loop would. */
		tick(time, frame) {
			if (!this._animationLoop) throw new Error('no animation loop set — start() not called?');
			this._animationLoop(time, frame);
		},
	};
	return renderer;
}

// ── Viewer shim ────────────────────────────────────────────────────────────--
// Mirrors src/irl.js's xrViewer: a real Scene + content Object3D so the reticle
// and content transforms exercise real Three math; everything else is the minimal
// surface WebXRSession reads. activeCamera/mixer/animationManager are real-enough
// stand-ins (no GPU needed).
export function createFakeViewer({ renderer = createFakeRenderer() } = {}) {
	const scene = new Scene();
	const content = new Object3D();
	content.name = 'content';
	scene.add(content);
	return {
		renderer,
		scene,
		content,
		controls: { enabled: true },
		mixer: null,
		animationManager: { updateCount: 0, update() { this.updateCount += 1; } },
		_afterAnimateHooks: [],
		_rafId: null,
		prevTime: null,
		activeCamera: new PerspectiveCamera(),
		_needsRender: false,
		updateRenderLoopCount: 0,
		_updateRenderLoop() { this.updateRenderLoopCount += 1; },
	};
}

// ── Install / restore navigator.xr ─────────────────────────────────────────--
// node's global `navigator` is a getter-only object; we can still define an `xr`
// property on it (verified) and delete it after. Returns a restore() to call in
// afterEach so suites never leak a fake device into one another.
export function installFakeXr(xr) {
	const had = Object.prototype.hasOwnProperty.call(globalThis.navigator ?? {}, 'xr');
	const prev = globalThis.navigator?.xr;
	if (typeof globalThis.navigator === 'undefined') {
		Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
	}
	Object.defineProperty(globalThis.navigator, 'xr', { value: xr, configurable: true, writable: true });
	return function restore() {
		if (had) globalThis.navigator.xr = prev;
		else delete globalThis.navigator.xr;
	};
}

// ── Matrix builder ─────────────────────────────────────────────────────────--
// A hit pose matrix from a known translation + yaw, so a test asserts the exact
// numbers that flow out the far end (pin lat/lng/heading/height). Yaw is about
// world-Y (the floor normal stays up), matching a real floor hit.
export function hitMatrix({ x = 0, y = 0, z = 0, yawDeg = 0 } = {}) {
	const position = new Vector3(x, y, z);
	const half = (yawDeg * Math.PI) / 180 / 2;
	const quaternion = new Quaternion(0, Math.sin(half), 0, Math.cos(half));
	return new Matrix4().compose(position, quaternion, new Vector3(1, 1, 1));
}

// ── One-call rig ───────────────────────────────────────────────────────────--
// Installs navigator.xr, builds renderer + viewer, constructs the WebXRSession,
// and (optionally) starts it. Returns everything a test needs plus a restore().
export async function mountWebXR(sessionOpts = {}, { supported = true, start = true } = {}) {
	const xr = new FakeXRSystem({ supported });
	const restore = installFakeXr(xr);
	const renderer = createFakeRenderer();
	const viewer = createFakeViewer({ renderer });
	const { WebXRSession } = await import('../../src/ar/webxr.js');
	const session = new WebXRSession(viewer, sessionOpts);
	if (start) await session.start();
	return {
		xr,
		renderer,
		viewer,
		session,
		/** The fake XRSession the device handed out (null until start()). */
		get xrSession() { return xr.session; },
		restore,
	};
}
