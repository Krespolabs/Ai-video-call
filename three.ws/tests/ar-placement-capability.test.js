// Placement-capability resolver (src/ar/placement-capability.js): the small
// device-classification that replaced /irl's binary WebXR gate. It must pick the
// RICHEST path a device can deliver — webxr where immersive-ar exists, ARKit
// Quick Look on iOS, and the always-available compass+GPS Pin path otherwise —
// and never throw (a broken probe degrades to 'pin', not an exception).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePlacementCapability } from '../src/ar/placement-capability.js';

const ORIG_NAV = globalThis.navigator;

// Install a synthetic navigator: `xr` controls the immersive-ar probe, the rest
// drives the iOS sniff in canUseQuickLook().
function setNavigator({ xrSupported = null, ua = '', platform = 'Linux x86_64', maxTouchPoints = 0 } = {}) {
	const xr = xrSupported === null ? undefined : {
		isSessionSupported: vi.fn(async (mode) => mode === 'immersive-ar' && xrSupported === true),
	};
	if (xrSupported === 'throw') {
		xr.isSessionSupported = vi.fn(async () => { throw new Error('probe blew up'); });
	}
	Object.defineProperty(globalThis, 'navigator', {
		value: { xr, userAgent: ua, platform, maxTouchPoints },
		configurable: true,
		writable: true,
	});
}

afterEach(() => {
	Object.defineProperty(globalThis, 'navigator', { value: ORIG_NAV, configurable: true, writable: true });
	vi.restoreAllMocks();
});

describe('resolvePlacementCapability()', () => {
	it('returns "webxr" when immersive-ar is supported (Android Chrome)', async () => {
		setNavigator({ xrSupported: true, ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' });
		expect(await resolvePlacementCapability()).toBe('webxr');
	});

	it('prefers webxr over quicklook when a device somehow offers both', async () => {
		setNavigator({ xrSupported: true, ua: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 });
		expect(await resolvePlacementCapability()).toBe('webxr');
	});

	it('returns "quicklook" on iOS Safari (no immersive-ar)', async () => {
		setNavigator({ xrSupported: false, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari', platform: 'iPhone' });
		expect(await resolvePlacementCapability()).toBe('quicklook');
	});

	it('returns "quicklook" on iPadOS (MacIntel + touch points masquerade)', async () => {
		setNavigator({ xrSupported: false, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari', platform: 'MacIntel', maxTouchPoints: 5 });
		expect(await resolvePlacementCapability()).toBe('quicklook');
	});

	it('returns "pin" on a device with neither AR surface (desktop, old Android)', async () => {
		setNavigator({ xrSupported: false, ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', platform: 'Win32' });
		expect(await resolvePlacementCapability()).toBe('pin');
	});

	it('returns "pin" when navigator.xr is absent entirely', async () => {
		setNavigator({ xrSupported: null, ua: 'Mozilla/5.0 (X11; Linux) Firefox', platform: 'Linux x86_64' });
		expect(await resolvePlacementCapability()).toBe('pin');
	});

	it('never throws — a blown-up XR probe degrades to the next path, not an exception', async () => {
		// Probe throws AND it's an iPhone → falls through to quicklook, not a crash.
		setNavigator({ xrSupported: 'throw', ua: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 });
		expect(await resolvePlacementCapability()).toBe('quicklook');
		// Probe throws on a non-iOS device → the always-available Pin path.
		setNavigator({ xrSupported: 'throw', ua: 'Android', platform: 'Linux armv8l' });
		expect(await resolvePlacementCapability()).toBe('pin');
	});
});
