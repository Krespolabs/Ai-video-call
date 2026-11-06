// Real-funds agreement endpoint (GET/POST /api/legal/risk-ack). The client
// dialog that calls it (public/risk-ack.js) is covered in tests/risk-ack.test.js;
// this file covers the server side: what counts as a complete signature, what
// it refuses, whether it tells the caller the truth about the durable record,
// and the status read the client cross-checks against.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-legal-risk-secret-at-least-32ch';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const sqlState = { queue: [], calls: [] };

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		const next = sqlState.queue.shift();
		if (next instanceof Error) throw next;
		return next;
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: rlState.success })),
	},
	clientIp: () => '203.0.113.7',
}));

const sessionState = { user: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionState.user),
}));

const { RISK_ACK_VERSION, buildSignaturePayload } = await import('../../public/risk-ack.js');
const { resetRealFundsAgreementCache } = await import('../../api/_lib/real-funds-agreement.js');
const { default: handler } = await import('../../api/legal/risk-ack.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(body = null, { method = 'POST', origin = null, contentType, raw = null } = {}) {
	const bodyStr = raw ?? (body === null ? '' : JSON.stringify(body));
	const ct = contentType === undefined ? (body !== null || raw !== null ? 'application/json' : null) : contentType;
	const req = Readable.from([Buffer.from(bodyStr)]);
	req.method = method;
	req.url = '/api/legal/risk-ack';
	req.headers = {
		host: 'app.test',
		'user-agent': 'vitest',
		...(ct ? { 'content-type': ct } : {}),
		...(origin ? { origin } : {}),
	};
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(body, opts) {
	const res = makeRes();
	await handler(makeReq(body, opts), res);
	let json = null;
	try { json = JSON.parse(res.body); } catch { json = res.body; }
	return { res, status: res.statusCode, body: json };
}

const signatureRows = () => sqlState.calls.filter((c) => /insert into legal_signatures/.test(c.query));
const auditRows = () => sqlState.calls.filter((c) => /insert into audit_log/.test(c.query));
const validSignature = (over = {}) => ({
	...buildSignaturePayload({ name: 'Ada Lovelace', context: 'deposit', path: '/agents/abc' }),
	...over,
});

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
	sessionState.user = null;
	resetRealFundsAgreementCache();
});

describe('POST /api/legal/risk-ack', () => {
	it('records an anonymous signature with every document version, a text fingerprint, and the typed name', async () => {
		const { status, body } = await invoke(validSignature());
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, recorded: true, version: RISK_ACK_VERSION });
		const rows = signatureRows();
		expect(rows).toHaveLength(1);
		const v = rows[0].values;
		expect(v[0]).toBeNull(); // user_id: anonymous
		expect(v[1]).toBe(RISK_ACK_VERSION);
		const docs = JSON.parse(v[2]);
		for (const key of ['tos', 'risk', 'agentWallet']) {
			expect(docs[key].version).toBeGreaterThanOrEqual(1);
			expect(docs[key].sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(v[3]).toBe('Ada Lovelace');
		expect(JSON.parse(v[4])).toEqual({ eligible: true, noLiability: true });
		expect(v).toContain('deposit');
		expect(v).toContain('203.0.113.7');
		expect(auditRows()).toHaveLength(1);
		expect(auditRows()[0].values).toContain('risk-ack-accept');
	});

	it('attributes the signature to the signed-in account', async () => {
		sessionState.user = { id: 'user-42' };
		const { status } = await invoke(validSignature());
		expect(status).toBe(200);
		expect(signatureRows()[0].values[0]).toBe('user-42');
	});

	it('signs anonymously when the session lookup fails', async () => {
		const { getSessionUser } = await import('../../api/_lib/auth.js');
		getSessionUser.mockRejectedValueOnce(new Error('expired token'));
		const { status } = await invoke(validSignature());
		expect(status).toBe(200);
		expect(signatureRows()[0].values[0]).toBeNull();
	});

	it.each([
		['a stale version', { version: RISK_ACK_VERSION - 1 }, 'invalid_version'],
		['a future version', { version: RISK_ACK_VERSION + 1 }, 'invalid_version'],
		['a missing document', { documents: { tos: 3, risk: 2 } }, 'document_not_accepted'],
		['an outdated document version', { documents: { tos: 2, risk: 2, agentWallet: 1 } }, 'document_not_accepted'],
		['an unchecked attestation', { attestations: { eligible: true } }, 'attestation_missing'],
		['a truthy-but-not-true attestation', { attestations: { eligible: 'yes', noLiability: true } }, 'attestation_missing'],
		['no typed name', { signatureName: '' }, 'invalid_signature'],
		['a name with no letters', { signatureName: '---' }, 'invalid_signature'],
	])('refuses %s and records nothing', async (_label, over, code) => {
		const { status, body } = await invoke(validSignature(over));
		expect(status).toBe(400);
		expect(body.error).toBe(code);
		expect(signatureRows()).toHaveLength(0);
		expect(auditRows()).toHaveLength(0);
	});

	it('refuses a non-object body', async () => {
		const { status, body } = await invoke([1, 2]);
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_body');
	});

	it('names the size limit when the body is too large', async () => {
		const { status, body } = await invoke(validSignature({ pad: 'a'.repeat(11_000) }));
		expect(status).toBe(413);
		expect(body.error).toBe('payload_too_large');
		expect(signatureRows()).toHaveLength(0);
	});

	it('names the content-type when the body is not JSON', async () => {
		const { status, body } = await invoke(null, { contentType: 'application/x-www-form-urlencoded', raw: 'version=2' });
		expect(status).toBe(415);
		expect(body.error).toBe('unsupported_media_type');
	});

	it('refuses an unparseable body', async () => {
		const { status, body } = await invoke(null, { raw: '{oops' });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
	});

	it('drops a malformed context or path rather than storing it', async () => {
		const { status } = await invoke(validSignature({ context: 'NOT A SLUG!', path: 'no-leading-slash' }));
		expect(status).toBe(200);
		const v = signatureRows()[0].values;
		expect(v[5]).toBeNull();
		expect(v[6]).toBeNull();
	});

	it('answers 503 when the signature could not be stored, so the dialog asks again', async () => {
		sqlState.queue = [new Error('relation "legal_signatures" does not exist')];
		const { status, body } = await invoke(validSignature());
		expect(status).toBe(503);
		expect(body.error).toBe('signature_not_recorded');
		expect(auditRows()).toHaveLength(0);
	});

	it('rate limits', async () => {
		rlState.success = false;
		const { status } = await invoke(validSignature());
		expect(status).toBe(429);
		expect(signatureRows()).toHaveLength(0);
	});

	it('allows any origin without credentials, so merchant-site embeds sign anonymously', async () => {
		const { res, status } = await invoke(validSignature(), { origin: 'https://merchant.example' });
		expect(status).toBe(200);
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['access-control-allow-credentials']).toBeUndefined();
	});
});

describe('GET /api/legal/risk-ack', () => {
	it('reports an anonymous visitor as unauthenticated and unsigned without touching the database', async () => {
		const { status, body } = await invoke(null, { method: 'GET' });
		expect(status).toBe(200);
		expect(body).toMatchObject({ authenticated: false, signed: false, version: RISK_ACK_VERSION });
		expect(body.documents.map((d) => d.key)).toEqual(['tos', 'risk', 'agentWallet']);
		expect(sqlState.calls).toHaveLength(0);
	});

	it('reports a signed account with when and by whom', async () => {
		sessionState.user = { id: 'user-42' };
		sqlState.queue = [[{ created_at: '2026-09-17T18:00:00.000Z', signature_name: 'Ada Lovelace', context: 'deposit' }]];
		const { status, body } = await invoke(null, { method: 'GET' });
		expect(status).toBe(200);
		expect(body).toMatchObject({ authenticated: true, signed: true, signedAt: '2026-09-17T18:00:00.000Z', signatureName: 'Ada Lovelace' });
		expect(sqlState.calls[0].values).toContain(RISK_ACK_VERSION);
	});

	it('reports an unsigned account', async () => {
		sessionState.user = { id: 'user-42' };
		sqlState.queue = [[]];
		const { body } = await invoke(null, { method: 'GET' });
		expect(body).toMatchObject({ authenticated: true, signed: false, signedAt: null });
	});

	it('answers 503 rather than a false "unsigned" when the lookup fails', async () => {
		sessionState.user = { id: 'user-42' };
		sqlState.queue = [new Error('relation "legal_signatures" does not exist')];
		const { status } = await invoke(null, { method: 'GET' });
		expect(status).toBe(503);
	});

	it('rejects other methods', async () => {
		const { status } = await invoke(null, { method: 'DELETE' });
		expect(status).toBe(405);
	});
});
