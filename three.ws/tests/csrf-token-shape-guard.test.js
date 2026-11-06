import { describe, it, expect, vi } from 'vitest';

// Regression guard for the 403 csrf_missing storm on /api/api-keys (and the
// silent breakage of agent-wallet provisioning and IRL world-lines).
//
// GET /api/csrf-token historically returned the token ONLY under `data`:
//     { data: { token, expires_in } }
// Several clients hand-rolled the fetch and read the token off the top level
// (`j.token`, `const { token } = await r.json()`), got `undefined`, sent an
// empty x-csrf-token header, and the server rejected the mutation with 403.
//
// The permanent fix is server-side tolerance: the endpoint now returns the
// token at BOTH the top level and under `data`, so EVERY client accessor works
// regardless of the shape it expects. This test locks that contract in — if
// someone "cleans up" the redundant top-level token later, the class of bug
// comes back, and this fails the build before it ships.

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: async () => ({ id: 'user-test-1' }),
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

vi.mock('../api/_lib/csrf.js', () => ({
	issueCsrf: async () => ({ token: 'csrf-test-token-abc123', expiresIn: 3600 }),
}));

const { default: handler } = await import('../api/csrf-token.js');

function invoke() {
	const req = { method: 'GET', headers: {} };
	let body = null;
	let statusCode = 0;
	const res = {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		setHeader() {},
		getHeader() {},
		end(payload) {
			this.writableEnded = true;
			statusCode = this.statusCode;
			body = payload ? JSON.parse(payload) : null;
		},
	};
	return Promise.resolve(handler(req, res)).then(() => ({ statusCode, body }));
}

describe('CSRF token endpoint shape contract', () => {
	it('returns 200', async () => {
		const { statusCode } = await invoke();
		expect(statusCode).toBe(200);
	});

	it('exposes the token at the TOP LEVEL (j.token) so flat accessors work', async () => {
		const { body } = await invoke();
		expect(body.token).toBe('csrf-test-token-abc123');
	});

	it('also exposes the token under `data` (j.data.token) for envelope accessors', async () => {
		const { body } = await invoke();
		expect(body.data?.token).toBe('csrf-test-token-abc123');
	});

	it('top-level and nested token are identical (single issued token)', async () => {
		const { body } = await invoke();
		expect(body.token).toBe(body.data?.token);
	});
});
