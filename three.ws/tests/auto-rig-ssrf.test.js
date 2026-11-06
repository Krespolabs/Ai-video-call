// End-to-end SSRF guard on the two completion paths that fetch a provider URL
// without a webhook signature behind them: the browser regenerate-status poll and
// the cron sweep. A forged/compromised provider status() that returns a loopback
// or cloud-metadata resultGlbUrl must terminate the job cleanly — never persist
// the URL, never hand it to a finalize stage that would fetch it server-side.
//
// The provider is fully stubbed; no test ever touches a real network host. The
// real provider-result-url allowlist runs (not mocked) so this exercises the
// actual gate, while db/auth/finalize are mocked to observe the side effects.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: () => {} }));

// ── shared mutable state, set per-case ───────────────────────────────────────
const state = {
	pollJob: null,
	cronCandidates: [],
	statusReturn: null,
	pollUpdates: [],
	failJobCalls: [],
};

function resetState() {
	state.pollJob = null;
	state.cronCandidates = [];
	state.statusReturn = null;
	state.pollUpdates = [];
	state.failJobCalls = [];
}

// One sql mock serving both handlers, branching on the query text.
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = (Array.isArray(strings) ? strings.join('?') : String(strings)).toLowerCase();
	if (text.includes('returning job_id')) return []; // cron reap — no zombies in these tests
	if (text.includes('update avatar_regen_jobs')) {
		if (text.includes('result_glb_url =')) {
			// Poll persist: set status, result_glb_url, error.
			state.pollUpdates.push({ status: values[0], result_glb_url: values[1], error: values[2] });
			return [];
		}
		if (text.includes("status = 'failed'")) {
			// Cron failJob: error, jobId, userId.
			state.failJobCalls.push({ error: values[0], jobId: values[1], userId: values[2] });
			return [];
		}
		return [];
	}
	if (text.includes('select') && text.includes('from avatar_regen_jobs')) {
		if (text.includes("mode = 'rerig'")) return state.cronCandidates; // cron candidate scan
		return state.pollJob ? [state.pollJob] : []; // poll single-job lookup
	}
	return [];
});
vi.mock('../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// Auth: an authenticated session user for the poll handler.
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: async () => ({ id: 'u1' }),
	authenticateBearer: async () => null,
	extractBearer: () => null,
	hasScope: () => true,
}));

// Provider: status() returns whatever the case configured.
const providerInstance = { status: vi.fn(async () => state.statusReturn) };
vi.mock('../api/_lib/regen-provider.js', () => ({
	getRegenProvider: async () => ({ name: 'replicate', instance: providerInstance }),
	getRegenProviderForMode: async () => ({ name: 'replicate', instance: providerInstance }),
	getRegenProviderForJob: async () => ({ name: 'replicate', instance: providerInstance }),
	getRegenProviderByName: async () => ({ name: 'replicate', instance: providerInstance }),
	BYOK_REGEN_PROVIDERS: [],
}));

// Finalize stages: spies we assert are NOT called on a blocked URL.
const finalizeAutoRigStageMock = vi.fn(async () => ({ status: 'done', resultAvatarId: 'sib-1' }));
vi.mock('../api/_lib/auto-rig.js', () => ({
	finalizeAutoRigStage: (...a) => finalizeAutoRigStageMock(...a),
	rigInfoIsRigged: () => false,
}));
const finalizeReconstructStageMock = vi.fn(async () => ({ status: 'done', resultAvatarId: 'rec-1' }));
const pollRiggingStageMock = vi.fn(async () => ({ status: 'rigging' }));
vi.mock('../api/_lib/reconstruct-finalize.js', () => ({
	finalizeReconstructStage: (...a) => finalizeReconstructStageMock(...a),
	pollRiggingStage: (...a) => pollRiggingStageMock(...a),
}));

const { dispatch } = await import('../api/avatars/_actions.js');
const cronHandler = (await import('../api/cron/auto-rig-sweep.js')).default;

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

function pollReq(jobId) {
	return { method: 'GET', url: `/api/avatars/regenerate-status?jobId=${jobId}`, headers: {} };
}

const LOOPBACK = 'http://127.0.0.1/x.glb';
const METADATA = 'http://169.254.169.254/latest/meta-data/x.glb';
const VALID = 'https://pbxt.replicate.delivery/abc/x.glb';

beforeEach(() => {
	vi.clearAllMocks();
	resetState();
	process.env.CRON_SECRET = 'test-cron-secret';
});

describe('(a) browser-poll path — regenerate-status', () => {
	function baseJob() {
		return {
			job_id: 'poll-1',
			status: 'running',
			result_avatar_id: null,
			result_glb_url: null,
			error: null,
			provider: 'replicate',
			ext_job_id: 'ext-1',
			created_at: new Date().toISOString(),
			mode: 'rerig',
			params: { auto_rig: true },
			source_avatar_id: 'src-1',
		};
	}

	it('fails the job and persists NO url when the provider returns a loopback host', async () => {
		state.pollJob = baseJob();
		state.statusReturn = { status: 'done', resultGlbUrl: LOOPBACK };

		const res = makeRes();
		await dispatch('regenerate-status', pollReq('poll-1'), res);

		expect(res.statusCode).toBe(200);
		expect(state.pollUpdates).toHaveLength(1);
		expect(state.pollUpdates[0]).toEqual({
			status: 'failed',
			result_glb_url: null,
			error: 'provider returned a disallowed result url',
		});
		// The poisoned URL never reaches a finalize stage.
		expect(finalizeAutoRigStageMock).not.toHaveBeenCalled();
		expect(finalizeReconstructStageMock).not.toHaveBeenCalled();
		expect(pollRiggingStageMock).not.toHaveBeenCalled();
	});

	it('also blocks a cloud-metadata host', async () => {
		state.pollJob = baseJob();
		state.statusReturn = { status: 'done', resultGlbUrl: METADATA };

		await dispatch('regenerate-status', pollReq('poll-1'), makeRes());

		expect(state.pollUpdates[0].status).toBe('failed');
		expect(state.pollUpdates[0].result_glb_url).toBeNull();
		expect(finalizeAutoRigStageMock).not.toHaveBeenCalled();
	});

	it('lets a valid Replicate delivery URL through to finalize', async () => {
		state.pollJob = baseJob();
		state.statusReturn = { status: 'done', resultGlbUrl: VALID };

		await dispatch('regenerate-status', pollReq('poll-1'), makeRes());

		// Persisted with the real URL (auto-rig keeps it non-terminal: 'running').
		expect(state.pollUpdates).toHaveLength(1);
		expect(state.pollUpdates[0].result_glb_url).toBe(VALID);
		expect(state.pollUpdates[0].status).toBe('running');
		expect(finalizeAutoRigStageMock).toHaveBeenCalledOnce();
		expect(finalizeAutoRigStageMock.mock.calls[0][0]).toMatchObject({ glbUrl: VALID });
	});
});

describe('(b) cron sweep path — auto-rig-sweep', () => {
	function cronReq() {
		return { method: 'GET', url: '/api/cron/auto-rig-sweep', headers: { authorization: 'Bearer test-cron-secret' } };
	}
	function candidate() {
		return {
			job_id: 'cron-1',
			user_id: 'u1',
			source_avatar_id: 'src-1',
			ext_job_id: 'ext-1',
			status: 'running',
			result_glb_url: null,
			created_at: new Date().toISOString(),
		};
	}

	it('fails the job without finalizing when the provider returns a metadata host', async () => {
		state.cronCandidates = [candidate()];
		state.statusReturn = { status: 'done', resultGlbUrl: METADATA };

		const res = makeRes();
		await cronHandler(cronReq(), res);

		expect(res.statusCode).toBe(200);
		const summary = JSON.parse(res._body);
		expect(summary.failed).toBe(1);
		expect(state.failJobCalls).toHaveLength(1);
		expect(state.failJobCalls[0]).toMatchObject({
			jobId: 'cron-1',
			error: 'provider returned a disallowed result url',
		});
		expect(finalizeAutoRigStageMock).not.toHaveBeenCalled();
	});

	it('blocks a poisoned URL already stored on the row (fast path)', async () => {
		state.cronCandidates = [{ ...candidate(), result_glb_url: LOOPBACK }];
		// No status() needed — the row already carries the (poisoned) URL.

		const res = makeRes();
		await cronHandler(cronReq(), res);

		const summary = JSON.parse(res._body);
		expect(summary.failed).toBe(1);
		expect(state.failJobCalls[0]).toMatchObject({ error: 'provider returned a disallowed result url' });
		expect(finalizeAutoRigStageMock).not.toHaveBeenCalled();
		expect(providerInstance.status).not.toHaveBeenCalled();
	});

	it('still finalizes a valid Replicate delivery URL', async () => {
		state.cronCandidates = [candidate()];
		state.statusReturn = { status: 'done', resultGlbUrl: VALID };

		const res = makeRes();
		await cronHandler(cronReq(), res);

		const summary = JSON.parse(res._body);
		expect(summary.finalized).toBe(1);
		expect(state.failJobCalls).toHaveLength(0);
		expect(finalizeAutoRigStageMock).toHaveBeenCalledOnce();
		expect(finalizeAutoRigStageMock.mock.calls[0][0]).toMatchObject({ glbUrl: VALID });
	});
});
