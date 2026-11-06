// Floor-placement capability resolver for /irl.
//
// Replaces the binary "WebXR or nothing" gate with a small resolver that picks
// the richest floor-placement path a device can actually deliver, so iOS Safari
// stops falling all the way back to compass+GPS when it can do real ARKit
// placement:
//
//   'webxr'     — immersive-ar with live hit-test + XRAnchor (Android Chrome and
//                 some desktop XR). In-canvas placement → real anchored pose →
//                 shareable GPS pin. The full-parity path (src/ar/webxr.js).
//   'quicklook' — iOS Safari / iPadOS. ARKit AR Quick Look opens the agent in the
//                 system AR viewer and places it on a detected plane. It is a
//                 SEPARATE viewer: it places-and-views in the user's room but
//                 cannot feed a pose back to our canvas, so the durable, shareable
//                 pin still comes from the gyro+GPS Pin path. The /irl copy says so.
//   'pin'       — no device AR surface (older Android, desktop, locked-down WebView)
//                 → compass + GPS "Pin here" is the placement, exactly as before.
//
// Extension point — a commercial in-canvas WebAR SLAM backend (e.g. 8th Wall)
// would slot in ABOVE 'webxr' as a 'webar' capability: true iOS in-canvas surface
// placement with pose callbacks that feed the SAME onFloorAnchored persistence in
// src/irl.js, achieving full parity (live placement → shareable pin) on iOS. It is
// intentionally NOT wired here because it requires a paid SDK + license key, and a
// key-less stub would be dead UI. When the credential exists, add the provider
// check as the first branch below and a matching backend in the /irl entry
// handler; nothing else changes, because persistence and UX are already shared.

import { WebXRSession } from './webxr.js';
import { canUseQuickLook } from './quick-look.js';

/** @typedef {'webxr'|'quicklook'|'pin'} PlacementCapability */

/**
 * Resolve the richest floor-placement path this device supports. Async because
 * the WebXR probe (`navigator.xr.isSessionSupported`) is async; never throws —
 * any failure resolves to the always-available 'pin' path.
 *
 * @returns {Promise<PlacementCapability>}
 */
export async function resolvePlacementCapability() {
	try {
		if (await WebXRSession.isSupported()) return 'webxr';
	} catch {
		// A thrown support probe (no navigator.xr, blocked API) is just "not webxr".
	}
	// iOS/iPadOS has no immersive-ar but does have ARKit Quick Look.
	if (canUseQuickLook()) return 'quicklook';
	return 'pin';
}
