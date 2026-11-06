// PATCH /api/irl/pins { calibrateRoom } — one-gesture whole-room align (R2).
//
// The headline alignment tool: an owner grabs the whole cluster and slides /
// twists it onto its true real-world spot once, moving every agent rigidly. This
// suite pins the API contract for that:
//   • owner-gated across EVERY pin — one stranger's agent denies the whole move;
//   • bounds reuse the A3 ceilings (±5 m move / ±46° rotate) with the 422 codes;
//   • the shared origin moves and each agent's absolute lat/lng is re-derived
//     from its UNCHANGED room offset (the geometry lives in room-anchor.js).
// DB / auth / limiter / guardian are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calibrateRoomOrigin, pinAbsoluteFromOrigin } from '../../src/irl/room-anchor.js';

const ORIGIN = { lat: 40.7128, lng: -74.006 };

// The cluster the SELECT returns. Tests mutate ownership / contents per case.
let roomPins = [];
// Captured UPDATE bindings so we can assert the persisted origin + per-pin coords.
let lastUpdate = null;

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	// SELECT the cluster.
	if (/SELECT/i.test(q) && /room_id =/i.test(q) && /rel_east_m/i.test(q) && !/UPDATE/i.test(q)) {
		return Promise.resolve(roomPins);
	}
	// The atomic UPDATE … unnest(...) write. Bound values arrive as the four arrays
	// (ids, lats, lngs, yaws) plus the scalar origin columns + the rotated flag.
	if (/UPDATE irl_pins/i.test(q) && /unnest/i.test(q)) {
		lastUpdate = { values };
		const ids = values.find((v) => Array.isArray(v) && typeof v[0] === 'string') || [];
		return Promise.resolve(ids.map((id) => ({ id })));
	}
	return Promise.resolve([]); // DDL + anything else
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		irlPinIp:     vi.fn(async () => ({ success: true })),
		irlPinBurst:  vi.fn(async () => ({ success: true })),
		irlPinHourly: vi.fn(async () => ({ success: true })),
		publicIp:     vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/granite-guardian.js', () => ({
	guardianConfig: () => ({ configured: false }), assess: vi.fn(), decide: vi.fn(),
}));

let handler;

function makeRes() {
	return {
		statusCode: 200, _h: {}, headersSent: false, writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function patch(body, headers = {}) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method: 'PATCH', headers: { host: 'x', ...headers }, query: {}, body }, res);
	let parsed = null; try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

// A two-agent cluster owned by device-A: couch 2 m east, wall 2 m west, true north.
const clusterByDevice = (token = 'device-A') => ([
	{ id: '11111111-1111-1111-1111-111111111111', user_id: null, device_token: token,
	  rel_east_m: 2, rel_north_m: 0, origin_lat: ORIGIN.lat, origin_lng: ORIGIN.lng, origin_yaw_deg: 0,
	  heading: 90, anchor_yaw_deg: 90 },
	{ id: '22222222-2222-2222-2222-222222222222', user_id: null, device_token: token,
	  rel_east_m: -2, rel_north_m: 0, origin_lat: ORIGIN.lat, origin_lng: ORIGIN.lng, origin_yaw_deg: 0,
	  heading: 270, anchor_yaw_deg: 270 },
]);

beforeEach(async () => {
	sqlMock.mockClear(); sessionUser = null; roomPins = []; lastUpdate = null;
	vi.resetModules();
	({ default: handler } = await import('../../api/irl/pins.js'));
});

describe('PATCH /api/irl/pins — room calibrate (R2)', () => {
	it('moves the whole cluster: shared origin shifts and each agent lat/lng is re-derived', async () => {
		roomPins = clusterByDevice();
		const { res, body } = await patch({
			deviceToken: 'device-A',
			calibrateRoom: { roomId: 'living-room-7', dEastM: 1.2, dNorthM: -0.4, dYawDeg: 0 },
		});
		expect(res.statusCode).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.moved).toBe(2);

		// The persisted origin matches the pure geodesy.
		const expected = calibrateRoomOrigin({ originLat: ORIGIN.lat, originLng: ORIGIN.lng, originYawDeg: 0, dEastM: 1.2, dNorthM: -0.4, dYawDeg: 0 });
		expect(body.origin.lat).toBeCloseTo(expected.originLat, 9);
		expect(body.origin.lng).toBeCloseTo(expected.originLng, 9);
		expect(body.origin.yawDeg).toBe(0);

		// The UPDATE bound the re-derived lat/lng for each agent (unchanged offsets).
		const arrays = lastUpdate.values.filter((v) => Array.isArray(v));
		const [ids, lats, lngs] = arrays;
		expect(ids).toHaveLength(2);
		const couch = pinAbsoluteFromOrigin({ ...expected, relEast: 2, relNorth: 0 });
		const idx = ids.indexOf('11111111-1111-1111-1111-111111111111');
		expect(lats[idx]).toBeCloseTo(couch.lat, 9);
		expect(lngs[idx]).toBeCloseTo(couch.lng, 9);
	});

	it('a rotation turns every agent facing by dYaw and persists the new frame yaw', async () => {
		roomPins = clusterByDevice();
		const { body } = await patch({
			deviceToken: 'device-A',
			calibrateRoom: { roomId: 'living-room-7', dEastM: 0, dNorthM: 0, dYawDeg: 30 },
		});
		expect(body.origin.yawDeg).toBe(30);
		const arrays = lastUpdate.values.filter((v) => Array.isArray(v));
		const yaws = arrays[3];
		// couch faced 90 → 120, wall faced 270 → 300.
		expect(yaws).toContain(120);
		expect(yaws).toContain(300);
	});

	it('rejects a non-owner — never moves a stranger’s agent (403)', async () => {
		roomPins = clusterByDevice('device-A');
		const { res, body } = await patch({
			deviceToken: 'device-B', // not the placer
			calibrateRoom: { roomId: 'living-room-7', dEastM: 1, dNorthM: 0, dYawDeg: 0 },
		});
		expect(res.statusCode).toBe(403);
		expect(body.error).toMatch(/owner/i);
		expect(lastUpdate).toBeNull(); // nothing written
	});

	it('one foreign agent in the cluster denies the whole move (403)', async () => {
		roomPins = [
			...clusterByDevice('device-A'),
			{ id: '33333333-3333-3333-3333-333333333333', user_id: null, device_token: 'device-Z',
			  rel_east_m: 0, rel_north_m: 3, origin_lat: ORIGIN.lat, origin_lng: ORIGIN.lng, origin_yaw_deg: 0,
			  heading: 0, anchor_yaw_deg: 0 },
		];
		const { res } = await patch({
			deviceToken: 'device-A',
			calibrateRoom: { roomId: 'living-room-7', dEastM: 1, dNorthM: 0, dYawDeg: 0 },
		});
		expect(res.statusCode).toBe(403);
		expect(lastUpdate).toBeNull();
	});

	it('rejects an over-bounds move and rotation with the 422 codes', async () => {
		roomPins = clusterByDevice();
		const move = await patch({
			deviceToken: 'device-A',
			calibrateRoom: { roomId: 'living-room-7', dEastM: 6, dNorthM: 0, dYawDeg: 0 },
		});
		expect(move.res.statusCode).toBe(422);
		expect(move.body.max_m).toBe(5);

		const rot = await patch({
			deviceToken: 'device-A',
			calibrateRoom: { roomId: 'living-room-7', dEastM: 0, dNorthM: 0, dYawDeg: 90 },
		});
		expect(rot.res.statusCode).toBe(422);
		expect(rot.body.max_deg).toBe(46);
	});

	it('404s an empty / unknown room rather than writing nothing silently', async () => {
		roomPins = [];
		const { res, body } = await patch({
			deviceToken: 'device-A',
			calibrateRoom: { roomId: 'ghost-room', dEastM: 1, dNorthM: 0, dYawDeg: 0 },
		});
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found/i);
	});

	it('rejects a malformed room id and non-finite offsets (400)', async () => {
		roomPins = clusterByDevice();
		const badId = await patch({ deviceToken: 'device-A', calibrateRoom: { roomId: 'Living Room!', dEastM: 1, dNorthM: 0, dYawDeg: 0 } });
		expect(badId.res.statusCode).toBe(400);
		const badNum = await patch({ deviceToken: 'device-A', calibrateRoom: { roomId: 'living-room-7', dEastM: 'NaN', dNorthM: 0, dYawDeg: 0 } });
		expect(badNum.res.statusCode).toBe(400);
	});

	it('lets an authenticated owner align a cluster placed under their account', async () => {
		sessionUser = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
		roomPins = clusterByDevice('device-A').map((p) => ({ ...p, user_id: sessionUser.id, device_token: null }));
		const { res, body } = await patch({
			calibrateRoom: { roomId: 'living-room-7', dEastM: 0.5, dNorthM: 0.5, dYawDeg: 0 },
		});
		expect(res.statusCode).toBe(200);
		expect(body.moved).toBe(2);
	});
});
