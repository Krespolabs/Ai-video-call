/**
 * The forge text→3D / image→3D poll (GET /api/forge?job=<id>) must never relay a
 * provider's raw failure string to a buyer. The Replicate/Meshy/Tripo/GCP/NVIDIA
 * status adapters return errors like "meshy task not found", "replicate returned
 * 500", "tripo poll failed: ECONNREFUSED 10.0.0.1:443", or Replicate's `detail`
 * (which can carry a billing page URL + the account's credit balance). The raw
 * value is persisted for operators via markFailed(); the wire must carry only the
 * neutral, masked copy from sanitizeJobError().
 *
 * These tests drive the real handler with a provider whose status() reports a
 * failed job carrying a vendor-leaking error, and assert the response masks it.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		REPLICATE_API_TOKEN: 'test-token',
	});
});

// Replicate is the default provider for a bare prediction-id job handle. Its
// status() reports a failed job whose error echoes the raw upstream detail —
// vendor name, billing URL, and the account credit balance all leak here.
const REPLICATE_LEAK =
	'failed: please add credit at https://replicate.com/account/billing — account has less than $5.0 in credit';
vi.mock('../../api/_providers/replicate.js', () => ({
	createRegenProvider: () => ({
		status: vi.fn(async () => ({ status: 'failed', error: REPLICATE_LEAK })),
	}),
}));

// markFailed must still receive the RAW error (operators need the real detail);
// only the wire is masked. Capture what it's called with to prove that split.
const markFailed = vi.fn(async () => {});
vi.mock('../../api/_lib/forge-store.js', () => ({
	hashClient: (v) => `client:${v || 'anon'}`,
	hashIp: (v) => `ip:${v}`,
	createCreation: vi.fn(async () => 'creation-1'),
	materializeCreation: vi.fn(async ({ glbUrl }) => ({ id: 'creation-1', glbUrl })),
	markFailed,
	findByJob: vi.fn(async () => null),
}));

vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: {
			...actual.limits,
			mcp3dStatus: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		},
		clientIp: () => '203.0.113.9',
	};
});

const { default: handler } = await import('../../api/forge.js');

// A bare 12+ hex prediction id routes to the default (replicate) poll path.
const JOB_ID = 'abcdef0123456789';

function makeReq() {
	return {
		method: 'GET',
		url: `/api/forge?job=${JOB_ID}`,
		headers: { 'x-forge-client': 'tester' },
		on() {},
	};
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(body) {
			this.body = body ? JSON.parse(body) : null;
		},
	};
}

describe('forge poll — failed-job error masking', () => {
	it('masks the raw provider failure string before it reaches the client', async () => {
		const req = makeReq();
		const res = makeRes();
		await handler(req, res);

		expect(res.body.status).toBe('failed');
		const wire = res.body.error || '';
		// The neutral, mapped copy — a billing/credit failure reads as transient.
		expect(wire).toMatch(/temporarily unavailable/i);
		// None of the vendor internals survive to the wire.
		expect(wire).not.toMatch(/replicate|meshy|tripo/i);
		expect(wire).not.toMatch(/https?:\/\//);
		expect(wire).not.toMatch(/credit|billing|\$\d/);
		expect(wire).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
	});

	it('persists the raw error for operators (markFailed) while masking the wire', async () => {
		markFailed.mockClear();
		const req = makeReq();
		const res = makeRes();
		await handler(req, res);

		// Operators keep the full detail…
		expect(markFailed).toHaveBeenCalledTimes(1);
		expect(markFailed.mock.calls[0][0].error).toBe(REPLICATE_LEAK);
		// …but the buyer never sees it.
		expect(res.body.error).not.toBe(REPLICATE_LEAK);
	});
});
