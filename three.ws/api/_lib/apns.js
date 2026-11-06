// Apple Push Notification service delivery for the three.ws iOS app.
//
// The iOS app is a WKWebView over the live site, and WKWebView runs no service
// worker, so Web Push (api/_lib/web-push.js) can never reach it. The app
// registers with APNs natively, POSTs its device token to /api/push/device,
// and api/_lib/notify.js calls sendApnsToUser beside sendPushToUser for every
// notification the user left push enabled on.
//
// Token-based auth (a .p8 signing key), not certificates: one key serves the
// sandbox and production hosts and never expires.
//
// Required env:
//   APNS_KEY_ID       the 10 character Key ID of the .p8 key
//   APNS_AUTH_KEY     the .p8 file's contents (PEM). Literal "\n" sequences are
//                     accepted, which is how a multi-line secret survives an
//                     env var.
//   APNS_TEAM_ID      the Apple Developer Team ID. Falls back to APPLE_TEAM_ID,
//                     which api/wk.js already reads for the app association.
// Optional:
//   APNS_BUNDLE_ID    the app's bundle id, which is the push topic
//                     (default ws.three.app).
//
// Every send is best effort: callers never await for correctness, and a
// missing key degrades to "no iOS push", never to an exception.

import http2 from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import { sql } from './db.js';

const HOSTS = {
	production: 'https://api.push.apple.com',
	sandbox: 'https://api.sandbox.push.apple.com',
};
const OTHER = { production: 'sandbox', sandbox: 'production' };

// Apple rejects a provider token older than an hour and throttles one
// refreshed more often than every 20 minutes. 50 minutes sits between.
const TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const EXPIRY_SECONDS = 24 * 60 * 60;

// APNs reasons that mean the token will never be deliverable again.
const DEAD_REASONS = new Set(['Unregistered', 'DeviceTokenNotForTopic', 'ExpiredToken']);

export const DEVICE_TOKEN_RE = /^[0-9a-f]{64,200}$/;

function env(name) {
	return (process.env[name] || '').trim();
}

function teamId() {
	return env('APNS_TEAM_ID') || env('APPLE_TEAM_ID');
}

export function apnsTopic() {
	return env('APNS_BUNDLE_ID') || 'ws.three.app';
}

export function apnsConfigured() {
	return Boolean(env('APNS_KEY_ID') && env('APNS_AUTH_KEY') && teamId());
}

let _signingKey = null;
let _token = null;

async function providerToken(now = Date.now()) {
	if (_token && now - _token.issuedAt < TOKEN_TTL_MS) return _token.jwt;
	if (!_signingKey) {
		const pem = env('APNS_AUTH_KEY').replace(/\\n/g, '\n');
		_signingKey = await importPKCS8(pem, 'ES256');
	}
	const jwt = await new SignJWT({})
		.setProtectedHeader({ alg: 'ES256', kid: env('APNS_KEY_ID') })
		.setIssuer(teamId())
		.setIssuedAt(Math.floor(now / 1000))
		.sign(_signingKey);
	_token = { jwt, issuedAt: now };
	return jwt;
}

// One HTTP/2 connection per host, reused across sends as Apple asks. A session
// that errors or receives GOAWAY is dropped and the next send opens a new one.
const sessions = new Map();

function sessionFor(environment) {
	const host = HOSTS[environment];
	const open = sessions.get(host);
	if (open && !open.closed && !open.destroyed) return open;
	const session = http2.connect(host);
	const drop = () => {
		if (sessions.get(host) === session) sessions.delete(host);
	};
	session.on('error', (err) => {
		console.error('[apns] session error:', err.code || err.message);
		drop();
	});
	session.on('goaway', drop);
	session.on('close', drop);
	// Idle connections should not keep an otherwise finished request alive.
	session.unref();
	sessions.set(host, session);
	return session;
}

/**
 * The APNs JSON for one notification. The custom keys ride beside `aps` and
 * arrive in the app as the notification's `data`, which ios/src/native-bridge.js
 * reads on tap.
 *
 * @param {{ title: string, body: string, url?: string, notificationId?: string|null, category?: string, tag?: string }} payload
 * @param {number|null} badge unread count for the home screen icon, or null to leave it
 */
export function buildApnsPayload(payload, badge = null) {
	const aps = {
		alert: { title: String(payload.title || 'three.ws'), body: String(payload.body || '') },
		sound: 'default',
		// Groups a burst of the same kind (three sales in a minute) into one
		// stack in Notification Centre instead of three separate rows.
		'thread-id': String(payload.category || payload.tag || 'three.ws'),
	};
	if (Number.isInteger(badge) && badge >= 0) aps.badge = badge;
	return {
		aps,
		url: payload.url || '/notifications',
		notificationId: payload.notificationId || null,
		category: payload.category || null,
	};
}

/**
 * POSTs one notification to one device.
 *
 * @returns {Promise<{ status: number, reason: string|null }>} status 0 means the
 *          request never got an answer (network, timeout).
 */
export async function sendApns({ token, environment = 'production', body, collapseId }) {
	const jwt = await providerToken();
	const session = sessionFor(environment);
	const headers = {
		':method': 'POST',
		':path': `/3/device/${token}`,
		authorization: `bearer ${jwt}`,
		'apns-topic': apnsTopic(),
		'apns-push-type': 'alert',
		'apns-priority': '10',
		'apns-expiration': String(Math.floor(Date.now() / 1000) + EXPIRY_SECONDS),
	};
	// Apple caps the collapse id at 64 bytes; a notification id is a uuid.
	if (collapseId) headers['apns-collapse-id'] = String(collapseId).slice(0, 64);

	return new Promise((resolve) => {
		let status = 0;
		let raw = '';
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		let req;
		try {
			req = session.request(headers);
		} catch (err) {
			console.error('[apns] request failed to open:', err.message);
			done({ status: 0, reason: null });
			return;
		}
		req.setEncoding('utf8');
		req.setTimeout(REQUEST_TIMEOUT_MS, () => {
			req.close(http2.constants.NGHTTP2_CANCEL);
			done({ status: 0, reason: 'timeout' });
		});
		req.on('response', (h) => {
			status = Number(h[':status']) || 0;
		});
		req.on('data', (chunk) => {
			raw += chunk;
		});
		req.on('end', () => {
			let reason = null;
			if (raw) {
				try {
					reason = JSON.parse(raw).reason || null;
				} catch {
					reason = null;
				}
			}
			done({ status, reason });
		});
		req.on('error', (err) => {
			console.error('[apns] request error:', err.code || err.message);
			done({ status: 0, reason: null });
		});
		req.end(JSON.stringify(body));
	});
}

async function unreadCount(userId) {
	try {
		const [row] = await sql`
			select count(*)::int as n
			from user_notifications
			where user_id = ${userId} and read_at is null
		`;
		return row?.n ?? null;
	} catch {
		return null;
	}
}

/**
 * Deliver one notification to every iOS device a user has registered.
 * Returns the number of devices APNs accepted it for. Safe to call when APNs
 * is unconfigured (returns 0) or the user has no iPhone (returns 0).
 *
 * @param {string} userId
 * @param {{ title: string, body: string, url?: string, tag?: string, notificationId?: string|null, category?: string }} payload
 */
export async function sendApnsToUser(userId, payload) {
	if (!apnsConfigured()) return 0;

	let devices;
	try {
		devices = await sql`
			select id, token, environment
			from apns_devices
			where user_id = ${userId}
		`;
	} catch (err) {
		console.error('[apns] load devices failed:', err.message);
		return 0;
	}
	if (!devices.length) return 0;

	const body = buildApnsPayload(payload, await unreadCount(userId));
	const collapseId = payload.notificationId || null;
	const dead = [];
	let delivered = 0;

	await Promise.all(
		devices.map(async (device) => {
			try {
				let host = device.environment in HOSTS ? device.environment : 'production';
				let result = await sendApns({ token: device.token, environment: host, body, collapseId });
				// A sandbox token sent to production (or the reverse) answers
				// BadDeviceToken. Try the other host once before calling it dead.
				if (result.status === 400 && result.reason === 'BadDeviceToken') {
					host = OTHER[host];
					result = await sendApns({ token: device.token, environment: host, body, collapseId });
					if (result.status === 200) {
						sql`update apns_devices set environment = ${host} where id = ${device.id}`.catch((e) =>
							console.error('[apns] environment update failed:', e.message),
						);
					}
				}
				if (result.status === 200) {
					delivered++;
				} else if (result.status === 410 || DEAD_REASONS.has(result.reason) || result.reason === 'BadDeviceToken') {
					dead.push(device.id);
				} else {
					console.error('[apns] send failed', result.status, result.reason);
				}
			} catch (err) {
				console.error('[apns] send threw:', err.message);
			}
		}),
	);

	if (dead.length) {
		sql`delete from apns_devices where id = any(${dead})`.catch((e) =>
			console.error('[apns] prune failed:', e.message),
		);
	}
	return delivered;
}

// Test seam: forget the cached key, provider token and connections.
export function _resetApnsForTests() {
	_signingKey = null;
	_token = null;
	for (const s of sessions.values()) s.destroy();
	sessions.clear();
}
