// Web Push — client controller.
//
// Subscribes the browser to push via the already-registered VitePWA service
// worker, registers the subscription with the backend, and drives the
// re-engagement funnel's `returned` signal. Deliberately does NOT prompt on
// load — `enablePush()` is only ever called from a value moment (the inbox
// "turn on push" banner, or the preference center toggle).
//
// Inside the three.ws iOS app the same API drives Apple Push Notification
// service instead. The app's WKWebView runs no service worker, so Web Push is
// impossible there; the PushNotifications Capacitor plugin registers with
// APNs natively and the device token goes to /api/push/device. Every caller
// (the inbox banner, the preference center, /companion) works unchanged.
//
// Public API:
//   isPushSupported: true with a service worker, PushManager and Notification, or in the iOS app
//   getPushConfig()          → { pushEnabled, vapidPublicKey }
//   getPushState()           → { supported, permission, subscribed }
//   enablePush()             → subscribe + register; returns final state
//   disablePush()            → unsubscribe + deregister
//   trackReturnedFromPush()  → record `returned` when booted from a push click
//   refreshNativePushRegistration() → iOS app: re-send a changed APNs token

let _configPromise = null;

// The APNs device token this app install last registered, so disabling push
// can deregister exactly that device and a relaunch can detect a new token.
const NATIVE_TOKEN_KEY = 'threews:apns-token';
// Once per app session is enough to keep the server's copy of the token fresh.
const NATIVE_REFRESH_KEY = 'threews:apns-refreshed';
const NATIVE_REGISTER_TIMEOUT_MS = 15_000;

/**
 * The PushNotifications plugin when this page runs inside the three.ws iOS app,
 * null everywhere else. Read off the Capacitor global rather than imported: the
 * plugin package belongs to ios/package.json, not to the site bundle.
 */
function nativePushPlugin() {
	const cap = globalThis.Capacitor;
	if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'ios') return null;
	return cap.Plugins?.PushNotifications ?? null;
}

export function isPushSupported() {
	if (nativePushPlugin()) return true;
	return (
		typeof navigator !== 'undefined' &&
		'serviceWorker' in navigator &&
		typeof window !== 'undefined' &&
		'PushManager' in window &&
		'Notification' in window
	);
}

export async function getPushConfig() {
	if (!_configPromise) {
		_configPromise = fetch('/api/config', { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : null))
			.then((c) => ({
				// In the app, "push is available" means APNs is configured on the
				// server; VAPID keys are irrelevant to a WebView that cannot use them.
				pushEnabled: nativePushPlugin() ? Boolean(c?.nativePush?.ios) : Boolean(c?.pushEnabled),
				vapidPublicKey: c?.vapidPublicKey || '',
			}))
			.catch(() => ({ pushEnabled: false, vapidPublicKey: '' }));
	}
	return _configPromise;
}

export async function getPushState() {
	const native = nativePushPlugin();
	if (native) return nativePushState(native);
	if (!isPushSupported()) {
		return { supported: false, permission: 'unsupported', subscribed: false };
	}
	const permission = Notification.permission;
	let subscribed = false;
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		const sub = await reg?.pushManager?.getSubscription();
		subscribed = Boolean(sub);
	} catch {
		/* registration not ready yet */
	}
	return { supported: true, permission, subscribed };
}

// Subscribe + register. Returns { ok, reason?, state }. `reason` is one of
// 'unsupported' | 'unconfigured' | 'denied' | 'error' on failure.
export async function enablePush() {
	const native = nativePushPlugin();
	if (native) return enableNativePush(native);
	if (!isPushSupported()) return { ok: false, reason: 'unsupported', state: await getPushState() };

	const { pushEnabled, vapidPublicKey } = await getPushConfig();
	if (!pushEnabled || !vapidPublicKey) {
		return { ok: false, reason: 'unconfigured', state: await getPushState() };
	}

	const permission = await Notification.requestPermission();
	if (permission !== 'granted') {
		return { ok: false, reason: permission === 'denied' ? 'denied' : 'dismissed', state: await getPushState() };
	}

	try {
		const reg = await navigator.serviceWorker.ready;
		let sub = await reg.pushManager.getSubscription();
		if (!sub) {
			sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
			});
		}
		await registerSubscription(sub);
		return { ok: true, state: await getPushState() };
	} catch (err) {
		console.error('[push] subscribe failed', err);
		return { ok: false, reason: 'error', state: await getPushState() };
	}
}

export async function disablePush() {
	const native = nativePushPlugin();
	if (native) return disableNativePush(native);
	if (!isPushSupported()) return { ok: true };
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		const sub = await reg?.pushManager?.getSubscription();
		if (sub) {
			await deregisterSubscription(sub.endpoint);
			await sub.unsubscribe();
		}
		return { ok: true };
	} catch (err) {
		console.error('[push] unsubscribe failed', err);
		return { ok: false };
	}
}

// When the page boots from a push click (the SW appends ?source=push&n=<id>),
// record the `returned` funnel event and strip the params so a reload/share of
// the URL doesn't double-count or leak the notification id.
export async function trackReturnedFromPush() {
	try {
		const params = new URLSearchParams(location.search);
		if (params.get('source') !== 'push') return;
		const n = params.get('n');
		await fetch('/api/notifications/track', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				notification_id: n || undefined,
				channel: 'push',
				event: 'returned',
			}),
		}).catch(() => {});

		params.delete('source');
		params.delete('n');
		const qs = params.toString();
		const clean = location.pathname + (qs ? `?${qs}` : '') + location.hash;
		history.replaceState(null, '', clean);
	} catch {
		/* non-fatal */
	}
}

// ── iOS app (APNs) ───────────────────────────────────────────────────────────

// Capacitor's permission vocabulary, mapped onto Notification.permission's so
// callers need one set of branches.
function toNotificationPermission(receive) {
	if (receive === 'granted') return 'granted';
	if (receive === 'denied') return 'denied';
	return 'default';
}

function storedNativeToken() {
	try {
		return localStorage.getItem(NATIVE_TOKEN_KEY) || null;
	} catch {
		return null;
	}
}

function storeNativeToken(token) {
	try {
		if (token) localStorage.setItem(NATIVE_TOKEN_KEY, token);
		else localStorage.removeItem(NATIVE_TOKEN_KEY);
	} catch {
		/* storage disabled: the next enable simply re-registers */
	}
}

async function nativePushState(plugin) {
	let permission = 'default';
	try {
		permission = toNotificationPermission((await plugin.checkPermissions())?.receive);
	} catch {
		/* plugin not ready: report as not yet asked */
	}
	return { supported: true, permission, subscribed: permission === 'granted' && Boolean(storedNativeToken()) };
}

// register() answers through events, not its promise: the token arrives on
// `registration` once APNs replies to the app delegate. Resolves with the hex
// token, rejects on `registrationError` or when APNs never answers.
async function nativeDeviceToken(plugin) {
	const handles = [];
	try {
		const token = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('APNs did not answer')), NATIVE_REGISTER_TIMEOUT_MS);
			const settle = (fn, value) => {
				clearTimeout(timer);
				fn(value);
			};
			Promise.all([
				plugin.addListener('registration', (t) => settle(resolve, t?.value)),
				plugin.addListener('registrationError', (e) => settle(reject, new Error(e?.error || 'registration failed'))),
			])
				.then((hs) => {
					handles.push(...hs);
					return plugin.register();
				})
				.catch((err) => settle(reject, err));
		});
		if (!token) throw new Error('empty device token');
		return String(token).toLowerCase();
	} finally {
		for (const h of handles) h?.remove?.();
	}
}

// `previous` makes this a refresh the server only honours for the account that
// opted in (api/push/device.js). Resolves with the HTTP status.
async function registerNativeToken(token, previous = null) {
	const csrf = await getCsrf();
	const r = await fetch('/api/push/device', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
		body: JSON.stringify({ token, platform: 'ios', ...(previous ? { previous } : {}) }),
	});
	if (!r.ok && r.status !== 409) throw new Error(`device register failed: ${r.status}`);
	return r.status;
}

async function deregisterNativeToken(token) {
	const csrf = await getCsrf();
	await fetch('/api/push/device', {
		method: 'DELETE',
		credentials: 'include',
		headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
		body: JSON.stringify({ token }),
	}).catch(() => {});
}

async function enableNativePush(plugin) {
	const { pushEnabled } = await getPushConfig();
	if (!pushEnabled) return { ok: false, reason: 'unconfigured', state: await nativePushState(plugin) };

	let receive;
	try {
		receive = (await plugin.requestPermissions())?.receive;
	} catch (err) {
		console.error('[push] native permission request failed', err);
		return { ok: false, reason: 'error', state: await nativePushState(plugin) };
	}
	if (receive !== 'granted') {
		return {
			ok: false,
			reason: receive === 'denied' ? 'denied' : 'dismissed',
			state: await nativePushState(plugin),
		};
	}

	try {
		const token = await nativeDeviceToken(plugin);
		await registerNativeToken(token);
		storeNativeToken(token);
		return { ok: true, state: await nativePushState(plugin) };
	} catch (err) {
		console.error('[push] native register failed', err);
		return { ok: false, reason: 'error', state: await nativePushState(plugin) };
	}
}

async function disableNativePush(plugin) {
	const token = storedNativeToken();
	try {
		if (token) await deregisterNativeToken(token);
		await plugin.unregister();
		storeNativeToken(null);
		return { ok: true };
	} catch (err) {
		console.error('[push] native unregister failed', err);
		return { ok: false };
	}
}

/**
 * Keeps the server's copy of this device's APNs token current.
 *
 * Apple can issue a new token after a restore, a reinstall or an OS update,
 * and the old one then answers 410. Re-registering once per app session, and
 * only for a device that already opted in, means the server learns the new
 * token before the next notification rather than losing the device silently.
 * Never prompts: a device without permission is left alone.
 */
export async function refreshNativePushRegistration() {
	const plugin = nativePushPlugin();
	const previous = storedNativeToken();
	if (!plugin || !previous) return;
	try {
		if (sessionStorage.getItem(NATIVE_REFRESH_KEY) === '1') return;
		sessionStorage.setItem(NATIVE_REFRESH_KEY, '1');
	} catch {
		/* no session storage: refreshing once per page is still correct */
	}
	try {
		if ((await plugin.checkPermissions())?.receive !== 'granted') {
			storeNativeToken(null);
			return;
		}
		const token = await nativeDeviceToken(plugin);
		const status = await registerNativeToken(token, previous);
		// Someone else is signed in on this phone now. Forget the device rather
		// than enrol it for them; they can turn push on for themselves.
		storeNativeToken(status === 409 ? null : token);
	} catch (err) {
		console.error('[push] native refresh failed', err);
	}
}

// ── backend register/deregister ──────────────────────────────────────────────

async function registerSubscription(sub) {
	const csrf = await getCsrf();
	const r = await fetch('/api/push/subscribe', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
		body: JSON.stringify({ subscription: sub.toJSON() }),
	});
	if (!r.ok && r.status !== 201) throw new Error(`register failed: ${r.status}`);
}

async function deregisterSubscription(endpoint) {
	const csrf = await getCsrf();
	await fetch('/api/push/subscribe', {
		method: 'DELETE',
		credentials: 'include',
		headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
		body: JSON.stringify({ endpoint }),
	}).catch(() => {});
}

// Single-use CSRF token (server burns it on first use; never cache).
async function getCsrf() {
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.data?.token || null;
	} catch {
		return null;
	}
}

// VAPID keys arrive base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

// Auto-record a push-sourced return as soon as the module loads, and in the
// iOS app keep the device's APNs registration fresh.
if (typeof window !== 'undefined') {
	const boot = () => {
		trackReturnedFromPush();
		refreshNativePushRegistration();
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot, { once: true });
	} else {
		boot();
	}
}
