// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://three.ws/notifications" }
//
// src/push-notifications.js inside the iOS app. The WebView there has no
// service worker, so the same public API has to enrol the device with APNs
// through the PushNotifications plugin and register the token at
// /api/push/device. Every "turn on push" control on the site calls this
// module, so if this path breaks, push silently never works on iPhone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TOKEN = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';

function fakePushPlugin({ receive = 'granted', token = TOKEN, fail = null } = {}) {
	const listeners = {};
	const calls = [];
	return {
		calls,
		checkPermissions: async () => ({ receive }),
		requestPermissions: async () => {
			calls.push('requestPermissions');
			return { receive };
		},
		addListener: async (event, fn) => {
			listeners[event] = fn;
			return { remove: () => delete listeners[event] };
		},
		register: async () => {
			calls.push('register');
			// APNs answers the app delegate asynchronously, after register resolves.
			setTimeout(() => {
				if (fail) listeners.registrationError?.({ error: fail });
				else listeners.registration?.({ value: token });
			}, 0);
		},
		unregister: async () => {
			calls.push('unregister');
		},
	};
}

let fetchCalls;
function stubFetch({ nativeIos = true, deviceStatus = 201 } = {}) {
	fetchCalls = [];
	vi.stubGlobal('fetch', async (url, init = {}) => {
		fetchCalls.push({ url, init });
		if (url === '/api/config') return new Response(JSON.stringify({ pushEnabled: false, nativePush: { ios: nativeIos } }));
		if (url === '/api/csrf-token') return new Response(JSON.stringify({ data: { token: 'csrf-1' } }));
		if (url === '/api/push/device') return new Response('{}', { status: init.method === 'DELETE' ? 200 : deviceStatus });
		return new Response('{}');
	});
}

async function load(plugin) {
	vi.resetModules();
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'ios',
		Plugins: { PushNotifications: plugin },
	});
	return import('../src/push-notifications.js');
}

const deviceCalls = () => fetchCalls.filter((c) => c.url === '/api/push/device');

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('push in the iOS app', () => {
	it('reports push as supported although the WebView has no service worker', async () => {
		stubFetch();
		const mod = await load(fakePushPlugin());
		expect(mod.isPushSupported()).toBe(true);
	});

	it('offers push when the server has APNs configured, whatever VAPID says', async () => {
		stubFetch({ nativeIos: true });
		const mod = await load(fakePushPlugin());
		expect((await mod.getPushConfig()).pushEnabled).toBe(true);
	});

	it('hides push when the server cannot deliver to iPhone', async () => {
		stubFetch({ nativeIos: false });
		const plugin = fakePushPlugin();
		const mod = await load(plugin);
		const result = await mod.enablePush();
		expect(result).toMatchObject({ ok: false, reason: 'unconfigured' });
		expect(plugin.calls).not.toContain('requestPermissions');
	});

	it('asks permission, registers with APNs and sends the token to the device endpoint', async () => {
		stubFetch();
		const plugin = fakePushPlugin();
		const mod = await load(plugin);

		const result = await mod.enablePush();

		expect(result.ok).toBe(true);
		expect(result.state).toEqual({ supported: true, permission: 'granted', subscribed: true });
		expect(plugin.calls).toEqual(['requestPermissions', 'register']);
		const [post] = deviceCalls();
		expect(post.init.method).toBe('POST');
		expect(post.init.headers['x-csrf-token']).toBe('csrf-1');
		expect(JSON.parse(post.init.body)).toEqual({ token: TOKEN.toLowerCase(), platform: 'ios' });
	});

	it('reports a refusal as denied and registers nothing', async () => {
		stubFetch();
		const mod = await load(fakePushPlugin({ receive: 'denied' }));
		const result = await mod.enablePush();
		expect(result).toMatchObject({ ok: false, reason: 'denied' });
		expect(result.state.permission).toBe('denied');
		expect(deviceCalls()).toHaveLength(0);
	});

	it('surfaces an APNs registration failure instead of claiming success', async () => {
		stubFetch();
		const mod = await load(fakePushPlugin({ fail: 'no valid aps-environment entitlement' }));
		const result = await mod.enablePush();
		expect(result).toMatchObject({ ok: false, reason: 'error' });
		expect(result.state.subscribed).toBe(false);
		expect(deviceCalls()).toHaveLength(0);
	});

	it('deregisters exactly this device when push is turned off', async () => {
		stubFetch();
		const plugin = fakePushPlugin();
		const mod = await load(plugin);
		await mod.enablePush();
		fetchCalls.length = 0;

		expect(await mod.disablePush()).toEqual({ ok: true });
		const [del] = deviceCalls();
		expect(del.init.method).toBe('DELETE');
		expect(JSON.parse(del.init.body)).toEqual({ token: TOKEN.toLowerCase() });
		expect(plugin.calls).toContain('unregister');
		expect((await mod.getPushState()).subscribed).toBe(false);
	});
});

describe('refreshNativePushRegistration', () => {
	it('does nothing for a device that never opted in', async () => {
		stubFetch();
		const plugin = fakePushPlugin();
		const mod = await load(plugin);
		await mod.refreshNativePushRegistration();
		expect(plugin.calls).not.toContain('register');
		expect(deviceCalls()).toHaveLength(0);
	});

	it('re-sends the token as a refresh, proving the device was already this account', async () => {
		localStorage.setItem('threews:apns-token', TOKEN.toLowerCase());
		stubFetch();
		const mod = await load(fakePushPlugin());
		// The module refreshes once on load; wait for that pass.
		await vi.waitFor(() => expect(deviceCalls()).toHaveLength(1));
		expect(JSON.parse(deviceCalls()[0].init.body)).toEqual({
			token: TOKEN.toLowerCase(),
			platform: 'ios',
			previous: TOKEN.toLowerCase(),
		});
		// Once per app session.
		await mod.refreshNativePushRegistration();
		expect(deviceCalls()).toHaveLength(1);
	});

	it('forgets the device when a different account is signed in now', async () => {
		localStorage.setItem('threews:apns-token', TOKEN.toLowerCase());
		stubFetch({ deviceStatus: 409 });
		await load(fakePushPlugin());
		await vi.waitFor(() => expect(deviceCalls()).toHaveLength(1));
		await vi.waitFor(() => expect(localStorage.getItem('threews:apns-token')).toBeNull());
	});
});
