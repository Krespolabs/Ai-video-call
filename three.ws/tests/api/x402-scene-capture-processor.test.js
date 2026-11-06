// Scene Capture Video Queue Processor — autonomous pipeline branch coverage.
//
// Exercises runSceneCaptureProcessor() in isolation: the DB queue, the GPU
// provider, and the x402 payment client are all stubbed so no network / no chain
// is touched. We assert the full state machine:
//   • GPU worker unconfigured        → graceful skip, no payment
//   • empty queue                    → idle ok, no payment
//   • pending row                    → pay $0.01 then submit, row → processing
//   • payment rejected (402 / cap)   → no submit, row released, success=false
//   • processing row, worker done    → store .ply result, row → done, no payment
//   • processing row, worker running → touch + wait, no payment

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
// Mutable fixture the sql stub reads. Each test resets it.
const db = { processing: [], pending: [] };
const sqlLog = [];

function sqlText(strings) {
	return strings.join(' ? ').replace(/\s+/g, ' ').trim();
}

const sql = vi.fn((strings, ..._vals) => {
	const text = sqlText(strings);
	sqlLog.push(text);
	if (/^SELECT \* FROM scene_capture_queue WHERE status = 'processing'/.test(text)) {
		return Promise.resolve(db.processing);
	}
	if (/UPDATE scene_capture_queue SET status = 'submitting'/.test(text)) {
		return Promise.resolve(db.pending);
	}
	// CREATE TABLE / CREATE INDEX / INSERT INTO paid_assets / UPDATE …
	return Promise.resolve([]);
});

const provider = {
	supportsMode: vi.fn(() => true),
	submit: vi.fn(),
	status: vi.fn(),
};
let providerThrows = false;

const payX402 = vi.fn();

vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sql(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/ssrf.js', () => ({
	assertPublicHttpsUrl: vi.fn(async (u) => u),
	SsrfError: class SsrfError extends Error {},
}));
vi.mock('../../api/_providers/gcp.js', () => ({
	createRegenProvider: () => {
		if (providerThrows) throw new Error('GCP_RECONSTRUCTION_KEY env var is required');
		return provider;
	},
}));
vi.mock('../../api/_lib/x402/pay.js', () => ({
	payX402: (...a) => payX402(...a),
	bootstrapSolanaContext: vi.fn(async () => ({ buyer: {}, conn: {}, blockhash: 'bh', mintInfo: { decimals: 6 } })),
}));

const { runSceneCaptureProcessor } = await import('../../api/_lib/x402/scene-capture-processor.js');

// A full payment context so the processor never needs to bootstrap.
const CTX = {
	origin: 'https://three.ws',
	buyer: { publicKey: { toBase58: () => 'Buyer11111' } },
	conn: {}, blockhash: 'bh', mintInfo: { decimals: 6 },
	remainingCap: 5_000_000,
};

beforeEach(() => {
	db.processing = [];
	db.pending = [];
	sqlLog.length = 0;
	providerThrows = false;
	sql.mockClear();
	provider.supportsMode.mockReturnValue(true);
	provider.submit.mockReset();
	provider.status.mockReset();
	payX402.mockReset();
});

describe('runSceneCaptureProcessor', () => {
	it('skips gracefully when the GPU worker is unconfigured (no payment)', async () => {
		providerThrows = true;
		const out = await runSceneCaptureProcessor(CTX);
		expect(out.success).toBe(true);
		expect(out.skipped).toBe(true);
		expect(out.note).toBe('video2scene_unconfigured');
		expect(out.amountAtomic).toBe(0);
		expect(payX402).not.toHaveBeenCalled();
	});

	it('is an idle ok-tick when the queue is empty', async () => {
		const out = await runSceneCaptureProcessor(CTX);
		expect(out.success).toBe(true);
		expect(out.note).toBe('queue_empty');
		expect(out.amountAtomic).toBe(0);
		expect(payX402).not.toHaveBeenCalled();
		expect(provider.submit).not.toHaveBeenCalled();
	});

	it('pays $0.01 then submits a pending video to the worker', async () => {
		db.pending = [{ id: 7, video_url: 'https://cdn.example/clip.mp4', params: { fps: 8 }, attempts: 1 }];
		payX402.mockResolvedValue({ success: true, paid: true, amountAtomic: 10_000, txSig: 'TXSIG123', responseBody: { ok: true } });
		provider.submit.mockResolvedValue({ extJobId: 'JOB_ABC', eta: 60 });

		const out = await runSceneCaptureProcessor(CTX);

		// Real x402 payment against the metering credit endpoint, GET.
		expect(payX402).toHaveBeenCalledTimes(1);
		const payArg = payX402.mock.calls[0][0];
		expect(payArg.method).toBe('GET');
		expect(payArg.url).toContain('/api/x402/asset-download?slug=video2scene-processing-credit');
		expect(payArg.remainingCap).toBe(5_000_000);

		// Submitted to the GPU worker with the video2scene mode.
		expect(provider.submit).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 'video2scene', sourceUrl: 'https://cdn.example/clip.mp4' }),
		);

		// Outcome carries the real payment for the loop to record + meter.
		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(10_000);
		expect(out.txSig).toBe('TXSIG123');
		expect(out.note).toBe('submitted');
		expect(out.signalData).toMatchObject({ action: 'submit', queue_id: 7, state: 'processing', job_id: 'JOB_ABC' });

		// Row advanced to processing with job + tx persisted.
		expect(sqlLog.some((t) => /UPDATE scene_capture_queue SET status = 'processing', job_id/.test(t))).toBe(true);
	});

	it('does not submit when the x402 payment is rejected', async () => {
		db.pending = [{ id: 8, video_url: 'https://cdn.example/clip.mp4', params: {}, attempts: 1 }];
		payX402.mockResolvedValue({ success: false, skipped: true, amountAtomic: 10_000, txSig: null, errorMsg: 'http_402' });

		const out = await runSceneCaptureProcessor(CTX);

		expect(provider.submit).not.toHaveBeenCalled();
		expect(out.success).toBe(false);
		expect(out.note).toBe('payment_failed');
		expect(out.errorMsg).toBe('http_402');
	});

	it('stores the finished .ply result when a processing job completes', async () => {
		db.processing = [{ id: 5, job_id: 'JOB_ABC', status: 'processing' }];
		provider.status.mockResolvedValue({
			status: 'done',
			resultPointCloudUrl: 'https://r2.example/scene-5.ply',
			numPoints: 1_250_000,
			frames: 240,
		});

		const out = await runSceneCaptureProcessor(CTX);

		expect(payX402).not.toHaveBeenCalled(); // polls are free
		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(0);
		expect(out.note).toBe('completed');
		expect(out.signalData).toMatchObject({
			action: 'poll', queue_id: 5, state: 'done',
			result_url: 'https://r2.example/scene-5.ply', num_points: 1_250_000,
		});
		expect(sqlLog.some((t) => /UPDATE scene_capture_queue SET status = 'done', result_url/.test(t))).toBe(true);
	});

	it('waits without paying while a job is still running', async () => {
		db.processing = [{ id: 6, job_id: 'JOB_XYZ', status: 'processing' }];
		provider.status.mockResolvedValue({ status: 'running' });

		const out = await runSceneCaptureProcessor(CTX);

		expect(payX402).not.toHaveBeenCalled();
		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(0);
		expect(out.note).toBe('still_processing');
		expect(out.signalData).toMatchObject({ action: 'poll', queue_id: 6, state: 'running' });
	});
});
