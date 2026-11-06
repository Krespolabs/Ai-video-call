// @ts-check
// Monocular marker pose from a known-size QR (Epic M).
//
// Why this exists
// ───────────────
// To anchor an agent to a marker, a phone must know WHERE the marker is in 3D,
// not just where it is on screen. WebXR can hit-test for that, but only on
// Android Chrome and only inside an immersive session — and /irl's universal
// world-lock (iOS included) runs on the plain camera passthrough, no XR session.
// So this module recovers the marker's pose the way every marker AR system did
// before depth sensors: from a SINGLE camera, using the one extra fact a printed
// marker gives you — its real-world size. With the marker's physical edge length
// and the camera's field of view (src/irl/camera-fov.js already derives it), the
// pinhole model turns the QR's on-screen span into a metric distance, and its
// detected corners into a camera-space position + facing.
//
// Output is in CAMERA space (forward = −Z, right = +X, up = +Y — the Three.js
// camera convention). The caller transforms those points to world with the live
// camera (camera.localToWorld), then hands them to marker-anchor.js. Keeping the
// world transform in the caller (where the real camera quaternion lives) means
// this module stays pure numbers-in/numbers-out and the optics are unit-tested.
//
// Assumption: the marker is roughly fronto-parallel to the camera at lock time
// (the user is looking at it to scan it, so this holds well). Distance is from the
// mean edge span, which is robust to mild perspective; gross skew is rejected
// upstream by the scan loop's stability gate, not modelled here.

const DEG = Math.PI / 180;

// Default printed marker edge length, metres (~16 cm — a quarter-page print). The
// marker mode surfaces this so the user prints to scale; an off-by-scale print
// only scales distance linearly (the agent lands nearer/farther along the same
// ray), never breaks colocalization, since both phones read the SAME marker size.
export const DEFAULT_MARKER_SIZE_M = 0.16;

/**
 * Vertical focal length in pixels for a frame of height `frameH` shot at vertical
 * FOV `vfovDeg`. f = (H/2) / tan(vfov/2).
 * @param {number} vfovDeg  vertical field of view, degrees (from camera-fov.js)
 * @param {number} frameH   frame height, pixels
 * @returns {number} focal length in pixels (>0), or 0 for degenerate input
 */
export function focalLengthPx(vfovDeg, frameH) {
	const v = Number(vfovDeg), h = Number(frameH);
	if (!(v > 0) || !(h > 0)) return 0;
	const t = Math.tan((v * DEG) / 2);
	if (!(t > 0)) return 0;
	return (h / 2) / t;
}

/**
 * Metric distance (metres) to a marker of physical edge `markerSizeM` whose mean
 * on-screen edge is `spanPx`, under focal length `fpx`. Z = f · S / span.
 * @returns {number} distance in metres (>0), or 0 for degenerate input
 */
export function estimateDistanceM(spanPx, markerSizeM, fpx) {
	const s = Number(spanPx), S = Number(markerSizeM), f = Number(fpx);
	if (!(s > 0) || !(S > 0) || !(f > 0)) return 0;
	return (f * S) / s;
}

/**
 * A pixel + a forward depth → its point in CAMERA space (forward = −Z). The
 * principal point is the frame centre; image-Y (down) flips to camera-Y (up).
 * @param {number} px  pixel x (0 = left)
 * @param {number} py  pixel y (0 = top)
 * @param {{w:number,h:number}} frame
 * @param {number} fpx  focal length, pixels
 * @param {number} depthM  forward distance from the camera, metres
 * @returns {{x:number,y:number,z:number}} camera-space point (metres)
 */
export function cameraSpacePoint(px, py, frame, fpx, depthM) {
	if (!(fpx > 0)) return { x: 0, y: 0, z: -Math.max(0, Number(depthM) || 0) };
	const cx = frame.w / 2, cy = frame.h / 2;
	const Z = Math.max(0, Number(depthM) || 0);
	return {
		x: ((px - cx) / fpx) * Z,
		y: (-(py - cy) / fpx) * Z, // image y is down; camera y is up
		z: -Z,                     // forward is −Z
	};
}

/**
 * Full camera-space pose of a detected marker: its centre, a point on its right
 * edge (for facing), and the metric distance. The centre and right point are
 * placed at the same depth (fronto-parallel assumption), so their world-space
 * delta gives the marker's facing once the caller rotates them by the camera.
 *
 * @param {object} p
 * @param {{x:number,y:number}} p.center     marker centre in pixels (qr-detect cornerCenter)
 * @param {{x:number,y:number}} p.rightMid   marker right-edge midpoint in pixels (cornerRightMid)
 * @param {number} p.spanPx                  mean on-screen edge length, pixels (cornerSpanPx)
 * @param {{w:number,h:number}} p.frame      frame pixel size
 * @param {number} p.vfovDeg                 vertical FOV, degrees
 * @param {number} [p.markerSizeM]           physical marker edge, metres
 * @returns {{ center:{x,y,z}, right:{x,y,z}, distanceM:number, ok:boolean }}
 */
export function markerPoseCamera({ center, rightMid, spanPx, frame, vfovDeg, markerSizeM = DEFAULT_MARKER_SIZE_M }) {
	const fpx = focalLengthPx(vfovDeg, frame?.h);
	const distanceM = estimateDistanceM(spanPx, markerSizeM, fpx);
	const ok = fpx > 0 && distanceM > 0 && distanceM < 30; // >30 m = a bad read, not a room marker
	return {
		center: cameraSpacePoint(center.x, center.y, frame, fpx, distanceM),
		right: cameraSpacePoint(rightMid.x, rightMid.y, frame, fpx, distanceM),
		distanceM,
		ok,
	};
}
