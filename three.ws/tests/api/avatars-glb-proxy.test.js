// Tests for the /api/avatars/:id/:action dispatcher's GLB proxy routing.
//
// The valuable, provider-independent behaviour here is the URL routing the
// dispatcher performs before any storage work:
//   1. A `.glb`-terminating action (`model.glb`, `<uuid>.glb`, …) is normalised
//      to the bare `glb` action — so glTF viewers / NFT marketplaces that sniff
//      the URL extension load three.ws avatars unchanged.
//   2. That normalisation must NOT swallow `glb-versions` (no `.glb` suffix), and
//      unknown actions / malformed ids must 404 cleanly rather than 500.
//
// The bare `glb` action streams the GLB bytes from R2 (200, model/gltf-binary).
// We assert the routing via the CORS preflight, which the glb proxy answers with
// a wildcard 204 BEFORE touching the DB or R2 — keeping the suite fully offline.
// (A previous incarnation 302-redirected a hardcoded demo-avatar fixture; that
// seed data was removed in a platform audit pass, so the suite now exercises the
// real handler path instead of the deleted demo branch.)
//
// DB, R2, auth, and the zauth SDK are mocked so the suite runs with no network.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
// The routing paths under test (CORS preflight, anonymous 401, dispatcher 404s)
// all resolve before any storage access — so a DB or R2 hit means a path
// short-circuited later than expected. Fail loudly if one is reached.
vi.mock('../../api/_lib/db.js', () => ({
	sql: () => { throw new Error('DB should not be queried on a routing-only path'); },
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../../api/_lib/r2.js', () => ({
	r2: { send: () => { throw new Error('R2 should not be hit on a routing-only path'); } },
	publicUrl: (key) => `https://cdn.test/${key}`,
}));
// No credentials on any request → every auth path resolves anonymous.
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => null,
	authenticateBearer: async () => null,
	extractBearer: () => null,
	hasScope: () => false,
}));

import handler from '../../api/avatars/[id]/[action].js';

// A syntactically valid avatar UUID — the dispatcher 404s any non-uuid id before
// dispatching, so the demo-style `avatar_demo_*` ids no longer reach a handler.
const ID = '11111111-1111-4111-8111-111111111111';

function makeReq({ id, action, method = 'GET' } = {}) {
	return {
		method,
		url: `/api/avatars/${id}/${action}`,
		headers: { host: 'three.ws', origin: 'https://example.com' },
		query: { id, action },
	};
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(chunk) {
			if (chunk !== undefined) this.body = chunk;
			this.writableEnded = true;
			this.headersSent = true;
		},
	};
}

async function invoke(opts) {
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res);
	return res;
}

describe('GET /api/avatars/:id/:action — GLB proxy routing', () => {
	it('answers the bare `glb` preflight with a wildcard 204 (no DB/R2 touched)', async () => {
		const res = await invoke({ id: ID, action: 'glb', method: 'OPTIONS' });
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('normalises a `model.glb` action to the glb proxy (same wildcard preflight)', async () => {
		const res = await invoke({ id: ID, action: 'model.glb', method: 'OPTIONS' });
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('normalises a `<uuid>.GLB` action case-insensitively to the glb proxy', async () => {
		const res = await invoke({ id: ID, action: `${ID}.GLB`, method: 'OPTIONS' });
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('exposes the byte headers third-party hosts need on the preflight', async () => {
		const res = await invoke({ id: ID, action: 'model.glb', method: 'OPTIONS' });
		expect(res.getHeader('access-control-expose-headers')).toContain('content-length');
	});

	it('does not treat `glb-versions` as the glb proxy', async () => {
		// glb-versions has no `.glb` suffix, so the normalisation must leave it
		// alone. It auth-gates before any DB work, so an anonymous request 401s —
		// proving it routed to handleGlbVersions, not the wildcard glb proxy (which
		// would have answered 204/200 with no auth).
		const res = await invoke({ id: ID, action: 'glb-versions' });
		expect(res.statusCode).toBe(401);
	});

	it('404s an unknown action', async () => {
		const res = await invoke({ id: ID, action: 'not-a-real-action' });
		expect(res.statusCode).toBe(404);
	});

	it('404s a malformed (non-uuid) avatar id before dispatching', async () => {
		const res = await invoke({ id: 'avatar_demo_disk_cz', action: 'glb' });
		expect(res.statusCode).toBe(404);
	});
});
