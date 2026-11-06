// api/_lib/apns.js: push delivery to the iOS app.
//
// The transport is faked at node:http2 so the test never reaches Apple, but
// the provider token is signed with a real ES256 key and verified back, so the
// auth header is exactly what APNs would receive. What is pinned:
//   - an unconfigured deploy sends nothing and reads nothing;
//   - the request carries the topic, the provider token and the device path;
//   - the badge is the recipient's unread count;
//   - a sandbox token answered BadDeviceToken by production is retried on the
//     sandbox host and the row's environment is corrected;
//   - a token APNs says is gone is pruned.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock }));

// Scripted APNs: each request pops the next { status, reason } for its host.
const sent = [];
const script = { production: [], sandbox: [] };
vi.mock('node:http2', () => {
	const connect = (host) => {
		const session = new EventEmitter();
		session.closed = false;
		session.destroyed = false;
		session.unref = () => {};
		session.destroy = () => {
			session.destroyed = true;
		};
		session.request = (headers) => {
			const stream = new EventEmitter();
			stream.setEncoding = () => {};
			stream.setTimeout = () => {};
			stream.close = () => {};
			stream.end = (body) => {
				const env = host.includes('sandbox') ? 'sandbox' : 'production';
				sent.push({ host, env, headers, body: JSON.parse(body) });
				const next = script[env].shift() || { status: 200 };
				queueMicrotask(() => {
					stream.emit('response', { ':status': next.status });
					if (next.reason) stream.emit('data', JSON.stringify({ reason: next.reason }));
					stream.emit('end');
				});
			};
			return stream;
		};
		return session;
	};
	return { default: { connect, constants: { NGHTTP2_CANCEL: 8 } }, connect };
});

const apns = await import('../api/_lib/apns.js');

const USER = '28e98fb2-2a98-4500-b45a-5a9ad7b3f7a8';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PAYLOAD = {
	title: 'Skill sold',
	body: 'Someone bought Weather from your agent',
	url: '/dashboard/',
	notificationId: '2b1f4c1e-7d0a-4a55-9b8e-1f2d3c4b5a69',
	category: 'sales',
	tag: 'skill_purchased',
};

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SPKI = publicKey.export({ type: 'spki', format: 'pem' });

// Routes the handful of queries the sender makes to canned answers.
function database({ devices, unread = 2 }) {
	sqlMock.mockImplementation((strings) => {
		const q = strings.join(' ');
		if (q.includes('from apns_devices')) return Promise.resolve(devices);
		if (q.includes('from user_notifications')) return Promise.resolve([{ n: unread }]);
		return Promise.resolve([]);
	});
}
const writes = () =>
	sqlMock.mock.calls
		.map(([strings, ...values]) => ({ q: strings.join(' '), values }))
		.filter(({ q }) => q.startsWith('update') || q.trim().startsWith('delete'));

beforeEach(() => {
	apns._resetApnsForTests();
	sent.length = 0;
	script.production.length = 0;
	script.sandbox.length = 0;
	sqlMock.mockReset();
	vi.stubEnv('APNS_KEY_ID', 'ABC123DEFG');
	vi.stubEnv('APNS_TEAM_ID', 'TEAM123456');
	// Stored the way a multi-line secret survives an env var.
	vi.stubEnv('APNS_AUTH_KEY', PEM.replace(/\n/g, '\\n'));
	vi.stubEnv('APNS_BUNDLE_ID', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('apnsConfigured', () => {
	it('needs the key id, the key and a team id', () => {
		expect(apns.apnsConfigured()).toBe(true);
		vi.stubEnv('APNS_AUTH_KEY', '');
		expect(apns.apnsConfigured()).toBe(false);
	});

	it('takes the team id the app association already uses', () => {
		vi.stubEnv('APNS_TEAM_ID', '');
		vi.stubEnv('APPLE_TEAM_ID', 'TEAM123456');
		expect(apns.apnsConfigured()).toBe(true);
	});
});

describe('buildApnsPayload', () => {
	it('puts the alert under aps and the tap target beside it', () => {
		expect(apns.buildApnsPayload(PAYLOAD, 4)).toEqual({
			aps: {
				alert: { title: 'Skill sold', body: 'Someone bought Weather from your agent' },
				sound: 'default',
				'thread-id': 'sales',
				badge: 4,
			},
			url: '/dashboard/',
			notificationId: PAYLOAD.notificationId,
			category: 'sales',
		});
	});

	it('leaves the badge alone when the count is unknown', () => {
		expect(apns.buildApnsPayload(PAYLOAD, null).aps).not.toHaveProperty('badge');
	});

	it('opens the inbox when the notification links nowhere', () => {
		expect(apns.buildApnsPayload({ title: 't', body: 'b' }).url).toBe('/notifications');
	});
});

describe('sendApnsToUser', () => {
	it('sends nothing and reads nothing when APNs is not configured', async () => {
		vi.stubEnv('APNS_KEY_ID', '');
		expect(await apns.sendApnsToUser(USER, PAYLOAD)).toBe(0);
		expect(sqlMock).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it('delivers with a verifiable provider token, the app topic and the unread badge', async () => {
		database({ devices: [{ id: 'd1', token: TOKEN, environment: 'production' }], unread: 3 });

		expect(await apns.sendApnsToUser(USER, PAYLOAD)).toBe(1);
		const [req] = sent;
		expect(req.env).toBe('production');
		expect(req.headers[':path']).toBe(`/3/device/${TOKEN}`);
		expect(req.headers['apns-topic']).toBe('ws.three.app');
		expect(req.headers['apns-push-type']).toBe('alert');
		expect(req.headers['apns-collapse-id']).toBe(PAYLOAD.notificationId);
		expect(req.body.aps.badge).toBe(3);

		const jwt = req.headers.authorization.replace(/^bearer /, '');
		const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(SPKI, 'ES256'));
		expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'ABC123DEFG' });
		expect(payload.iss).toBe('TEAM123456');
	});

	it('reuses one provider token across sends, as Apple requires', async () => {
		database({ devices: [{ id: 'd1', token: TOKEN, environment: 'production' }] });
		await apns.sendApnsToUser(USER, PAYLOAD);
		await apns.sendApnsToUser(USER, PAYLOAD);
		expect(sent[0].headers.authorization).toBe(sent[1].headers.authorization);
	});

	it('retries a development token on the sandbox host and records where it lives', async () => {
		database({ devices: [{ id: 'd1', token: TOKEN, environment: 'production' }] });
		script.production.push({ status: 400, reason: 'BadDeviceToken' });

		expect(await apns.sendApnsToUser(USER, PAYLOAD)).toBe(1);
		expect(sent.map((r) => r.env)).toEqual(['production', 'sandbox']);
		await new Promise((r) => setTimeout(r, 0));
		const update = writes().find(({ q }) => q.includes('update apns_devices'));
		expect(update.values).toEqual(['sandbox', 'd1']);
	});

	it('prunes a device APNs says is gone', async () => {
		database({
			devices: [
				{ id: 'gone', token: TOKEN, environment: 'production' },
				{ id: 'live', token: TOKEN.replace('a1', 'b2'), environment: 'production' },
			],
		});
		script.production.push({ status: 410, reason: 'Unregistered' });

		expect(await apns.sendApnsToUser(USER, PAYLOAD)).toBe(1);
		await new Promise((r) => setTimeout(r, 0));
		const prune = writes().find(({ q }) => q.includes('delete from apns_devices'));
		expect(prune.values).toEqual([['gone']]);
	});

	it('keeps a device through a transient APNs error', async () => {
		database({ devices: [{ id: 'd1', token: TOKEN, environment: 'production' }] });
		script.production.push({ status: 503, reason: 'ServiceUnavailable' });

		expect(await apns.sendApnsToUser(USER, PAYLOAD)).toBe(0);
		await new Promise((r) => setTimeout(r, 0));
		expect(writes()).toHaveLength(0);
	});
});
