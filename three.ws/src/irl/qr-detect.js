// @ts-check
// QR marker detection for /irl indoor colocalization (Epic M).
//
// Why this exists
// ───────────────
// marker-anchor.js owns the pure frame math; this module owns the one impure
// thing it can't: turning camera pixels into a QR's screen-space geometry. It is
// a thin, capability-gated wrapper over the browser-native BarcodeDetector —
// available in Chrome on Android, which is exactly the WebXR immersive-ar target
// /irl already uses, so the demo path needs no new heavyweight CV dependency.
//
// Split out so the camera/loop concerns stay isolated and the PURE helpers
// (corner geometry, screen→NDC, best-marker selection) are unit-tested without a
// camera. The marker's 3D pose is NOT computed here — that needs a WebXR
// hit-test, which only the session owner (src/irl.js) holds. This module hands up
// the QR's decoded value + its four screen corners; the caller ray-casts those
// corners into the world and feeds marker-anchor.js.
//
// Coordinate note: BarcodeDetector cornerPoints are in VIDEO-FRAME pixels, ordered
// clockwise from the top-left as the marker appears upright to the reader:
//   [0]=top-left  [1]=top-right  [2]=bottom-right  [3]=bottom-left.

/** Whether the browser can detect QR codes natively. */
export function barcodeDetectorSupported() {
	return typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis;
}

/**
 * Confirm the platform's BarcodeDetector actually lists `qr_code` (the API can
 * exist while a given format is unsupported). Resolves false on any error so a
 * caller can degrade to a designed "scanning unavailable" state, never throw.
 * @returns {Promise<boolean>}
 */
export async function qrDetectionAvailable() {
	if (!barcodeDetectorSupported()) return false;
	try {
		const formats = await globalThis.BarcodeDetector.getSupportedFormats();
		return Array.isArray(formats) && formats.includes('qr_code');
	} catch {
		return false;
	}
}

/** Average of the four corner points → the marker's screen-space centre. */
export function cornerCenter(corners) {
	let x = 0, y = 0;
	for (const c of corners) { x += c.x; y += c.y; }
	return { x: x / corners.length, y: y / corners.length };
}

/**
 * Midpoint of the marker's RIGHT edge (top-right ↔ bottom-right). Ray-casting
 * this point and the centre into the world gives the two world points
 * markerYawFromEdge needs to read the marker's facing.
 */
export function cornerRightMid(corners) {
	const tr = corners[1], br = corners[2];
	return { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 };
}

/**
 * The marker's on-screen size — the mean of its four edge lengths, in pixels.
 * Used to reject specks (too far / a QR glimpsed in a poster) before paying for a
 * hit-test, and to pick the most prominent marker when several are visible.
 */
export function cornerSpanPx(corners) {
	const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
	return (d(corners[0], corners[1]) + d(corners[1], corners[2]) +
		d(corners[2], corners[3]) + d(corners[3], corners[0])) / 4;
}

/** A pixel point → WebXR normalized device coords ([-1,1], y up) for hit-testing. */
export function screenToNdc(px, py, w, h) {
	return { x: (px / w) * 2 - 1, y: -((py / h) * 2 - 1) };
}

/**
 * Choose the marker to lock onto from a frame's detections: the largest one above
 * a minimum on-screen span (closer / more deliberate), tie-broken toward screen
 * centre. Returns null when nothing clears the gate. Pure → unit-tested.
 *
 * @param {Array<{cornerPoints:Array<{x:number,y:number}>, rawValue?:string}>} detections
 * @param {object} [opts]
 * @param {number} [opts.minSpanPx=44]  reject markers smaller than this (too far to trust)
 * @param {{w:number,h:number}} [opts.frame]  frame size, for the centre tie-break
 * @returns {{cornerPoints:Array<{x:number,y:number}>, rawValue?:string, spanPx:number}|null}
 */
export function pickBestMarker(detections, { minSpanPx = 44, frame } = {}) {
	if (!Array.isArray(detections) || !detections.length) return null;
	const cx = frame ? frame.w / 2 : 0;
	const cy = frame ? frame.h / 2 : 0;
	let best = null;
	for (const d of detections) {
		const corners = d?.cornerPoints;
		if (!Array.isArray(corners) || corners.length !== 4) continue;
		if (!corners.every((c) => Number.isFinite(c?.x) && Number.isFinite(c?.y))) continue;
		const spanPx = cornerSpanPx(corners);
		if (spanPx < minSpanPx) continue;
		const c = cornerCenter(corners);
		const offCentre = frame ? Math.hypot(c.x - cx, c.y - cy) : 0;
		// Score favours bigger markers; the centre offset is a mild tie-break (a
		// pixel of span outweighs a pixel of offset), so the deliberate, close
		// marker wins over an incidental one at the frame edge.
		const score = spanPx - offCentre * 0.25;
		if (!best || score > best.score) best = { ...d, spanPx, score };
	}
	if (!best) return null;
	const { score, ...rest } = best;
	return rest;
}

/**
 * A throttled QR scan loop over a live <video>. Calls `onMarker` with the picked
 * detection (decoded value + screen corners + span) at most ~6×/s; the caller
 * decides when a stable lock is reached and ray-casts the corners. Detection runs
 * off an ImageBitmap of the current frame so it never blocks the WebGL/AR loop.
 *
 * Returns a controller with stop(). Self-heals: a transient detect() error is
 * swallowed and retried next tick (camera frames are momentarily unreadable
 * during AR session transitions); a hard-unsupported platform never starts.
 *
 * @param {object} p
 * @param {HTMLVideoElement} p.video         the camera passthrough element
 * @param {(m:{rawValue?:string, cornerPoints:Array<{x:number,y:number}>, spanPx:number, frame:{w:number,h:number}}) => void} p.onMarker
 * @param {() => void} [p.onIdle]            called on a tick that found no usable marker
 * @param {number} [p.intervalMs=160]        min gap between detections (~6 fps)
 * @param {number} [p.minSpanPx=44]
 * @returns {{ stop: () => void }}
 */
export function startQrScanLoop({ video, onMarker, onIdle, intervalMs = 160, minSpanPx = 44 }) {
	let stopped = false;
	let detector = null;
	let lastRun = 0;
	let rafId = 0;

	try {
		detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
	} catch {
		// Unsupported — caller should have gated on qrDetectionAvailable(); bail safely.
		return { stop() {} };
	}

	const tick = async (ts) => {
		if (stopped) return;
		rafId = requestAnimationFrame(tick);
		if (ts - lastRun < intervalMs) return;
		lastRun = ts;
		const w = video.videoWidth, h = video.videoHeight;
		if (!w || !h || video.paused) return;
		let bitmap;
		try {
			bitmap = await createImageBitmap(video);
			const detections = await detector.detect(bitmap);
			const picked = pickBestMarker(detections, { minSpanPx, frame: { w, h } });
			if (stopped) return;
			if (picked) onMarker({ ...picked, frame: { w, h } });
			else onIdle?.();
		} catch {
			// Frame momentarily unreadable (AR transition / GPU stall) — skip this tick.
			onIdle?.();
		} finally {
			bitmap?.close?.();
		}
	};
	rafId = requestAnimationFrame(tick);

	return {
		stop() {
			stopped = true;
			if (rafId) cancelAnimationFrame(rafId);
		},
	};
}
