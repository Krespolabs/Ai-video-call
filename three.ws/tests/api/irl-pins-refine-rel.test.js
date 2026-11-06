// PATCH /api/irl/pins { calibrate: { …, relEast, relNorth } } — per-agent refine (R3).
//
// "Refine on floor" re-places ONE room agent from a fresh WebXR hit. A room pin
// renders from rel_east_m / rel_north_m (not the absolute lat/lng), so the calibrate
// PATCH must persist the new offset — otherwise the sharpened spot snaps back on the
// next viewer re-fetch. This suite pins that contract:
//   • a room pin's calibrate updates rel_east_m / rel_north_m (the render-authoritative
//     columns) and never touches the shared origin (origin_lat/lng stay put);
//   • the offset move is bounded by the same A3 ceiling (±5 m) with the 422 code;
//   • a non-room pin ignores rel (its absolute lat/lng stays authoritative).
// DB / auth / limiter / guardian are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORIGIN = { lat: 40.7128, lng: -74.006 };
const ID = '11111111-1111-1111-1111-111111111111';

// The single pin the per-agent SELECT returns. Tests mutate it per case.
let thePin = null;
// Captured per-agent UPDATE: the joined query text + bound values, so we can assert
// what was written (and what was NOT — the origin must never appear).
let lastUpdate = null;

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	// Per-agent calibrate SELECT (by id, carries rel_*; NOT the room_id= cluster read).
	if (/SELECT/i.test(q) && /WHERE id =/i.test(q) && /rel_east_m/i.test(q) && !/room_id =/i.test(q)) {
		return Promise.resolve(thePin ? [thePin] : []);
	}
	// The per-agent UPDATE … RETURNING (no unnest — that's the room path).
	if (/UPDATE irl_pins SET/i.test(q) && !/unnest/i.test(q)) {
		lastUpdate = { q, values };
		return Promise.resolve([{ id: ID }]);
	}
	return Promise.resolve([]); // DDL + anything else
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => null) }));
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

// A room pin owned by device-A: couch 2 m east of the origin, true-north frame.
const roomPin = (token = 'device-A') => ({
	id: ID, user_id: null, device_token: token,
	lat: ORIGIN.lat, lng: ORIGIN.lng, heading: 90, anchor_yaw_deg: 90, anchor_height_m: 0,
	room_id: 'living-room-7', rel_east_m: 2, rel_north_m: 0, expires_at: null, hidden_at: null,
});

beforeEach(async () => {
	sqlMock.mockClear(); thePin = null; lastUpdate = null;
	vi.resetModules();
	({ default: handler } = await import('../../api/irl/pins.js'));
});

describe('PATCH /api/irl/pins — per-agent floor refine (R3)', () => {
	it('updates rel_east_m / rel_north_m for a room pin and never moves the origin', async () => {
		thePin = roomPin();
		// Sharpen the couch agent from (2,0) to (2.4, 0.3) — well within the ±5 m ceiling.
		const next = { relEast: 2.4, relNorth: 0.3 };
		const { res, body } = await patch({
			id: ID, deviceToken: 'device-A',
			calibrate: { lat: ORIGIN.lat + 0.0000027, lng: ORIGIN.lng + 0.0000035, anchorHeightM: -1.4, ...next },
		});
		expect(res.statusCode).toBe(200);
		expect(body.calibrated).toBe(true);
		// The UPDATE set the room offset columns with the new values…
		expect(lastUpdate.q).toMatch(/rel_east_m\s*=/);
		expect(lastUpdate.q).toMatch(/rel_north_m\s*=/);
		expect(lastUpdate.values).toContain(2.4);
		expect(lastUpdate.values).toContain(0.3);
		// …and never touches the shared origin — refine sharpens one agent only.
		expect(lastUpdate.q).not.toMatch(/origin_lat\s*=/);
		expect(lastUpdate.q).not.toMatch(/origin_yaw_deg\s*=/);
	});

	it('rejects an offset move beyond the ±5 m ceiling (422), origin untouched', async () => {
		thePin = roomPin();
		// 9 m east of the stored (2,0) offset — a relocation, not a refine.
		const { res, body } = await patch({
			id: ID, deviceToken: 'device-A',
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng, relEast: 11, relNorth: 0 },
		});
		expect(res.statusCode).toBe(422);
		expect(body.error).toMatch(/move too large/i);
		expect(lastUpdate).toBeNull(); // nothing written
	});

	it('only the owner can refine — a stranger device is denied (403)', async () => {
		thePin = roomPin('device-A');
		const { res } = await patch({
			id: ID, deviceToken: 'device-B',
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng, relEast: 2.2, relNorth: 0 },
		});
		expect(res.statusCode).toBe(403);
		expect(lastUpdate).toBeNull();
	});

	it('a non-room pin ignores rel — its absolute lat/lng stays authoritative', async () => {
		thePin = { ...roomPin(), room_id: null, rel_east_m: null, rel_north_m: null };
		const { res } = await patch({
			id: ID, deviceToken: 'device-A',
			calibrate: { lat: ORIGIN.lat + 0.00001, lng: ORIGIN.lng, relEast: 2.4, relNorth: 0.3 },
		});
		expect(res.statusCode).toBe(200);
		// rel columns COALESCE to null (no change) — the bound rel values are absent.
		expect(lastUpdate.values).not.toContain(2.4);
		expect(lastUpdate.values).not.toContain(0.3);
	});
});
