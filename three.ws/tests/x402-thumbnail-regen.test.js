// Unit tests for the Avatar Thumbnail Regeneration pipeline (USE-015):
// api/_lib/x402/thumbnail-regen.js.
//
// The DB and the shared x402 payment client are mocked. The sql mock dispatches
// on query text so the (idempotent) schema DDL in ensureRegenSchema is ignored
// and only the meaningful SELECT/INSERT/UPDATE results are asserted on.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock DB: route by query text ────────────────────────────────────────────
const dbState = {
	staleAsset: null,   // row selectStaleAsset returns (or null → [])
	enqueueId: 99,      // RETURNING id from enqueue (null → conflict/no-op)
	calls: [],          // captured { text } for assertions
};

vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		const text = Array.isArray(strings) ? strings.join('?') : String(strings);
		dbState.calls.push({ text, values });
		if (/FROM\s+paid_assets\s+pa/i.test(text)) {
			return dbState.staleAsset ? [dbState.staleAsset] : [];
		}
		if (/INSERT\s+INTO\s+avatar_thumbnail_regen_jobs/i.test(text)) {
			return dbState.enqueueId == null ? [] : [{ id: dbState.enqueueId }];
		}
		if (/UPDATE\s+avatar_thumbnail_regen_jobs/i.test(text) && /RETURNING/i.test(text)) {
			return dbState.claim || [];
		}
		return [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

// ── mock payment client ─────────────────────────────────────────────────────
const payState = { result: null, lastArgs: null };
vi.mock('../api/_lib/x402/pay.js', () => ({
	payX402: vi.fn(async (args) => {
		payState.lastArgs = args;
		if (payState.result instanceof Error) throw payState.result;
		return payState.result;
	}),
}));

import {
	runThumbnailRegen,
	enqueueRegenJob,
	thumbnailKeyFor,
	THUMBNAIL_REGEN_ENDPOINT,
	STALE_DAYS,
} from '../api/_lib/x402/thumbnail-regen.js';
import { payX402 } from '../api/_lib/x402/pay.js';

const SOLANA_CTX = {
	origin: 'https://three.ws',
	buyer: { publicKey: { toBase58: () => 'BuyerPubkey1111' } },
	conn: {},
	blockhash: 'hash',
	mintInfo: { decimals: 6 },
	remainingCap: 5_000_000,
	runId: '11111111-2222-3333-4444-555555555555',
	log: { info() {}, warn() {} },
};

const ASSET = {
	id: 'asset-uuid-1',
	slug: 'pole-dancer-rumba',
	title: 'Pole Dancer (Rumba)',
	r2_key: 'assets/pole-dancer-rumba.glb',
	avatar_id: 'avatar-uuid-1',
	price_atomics: '5000',
};

beforeEach(() => {
	dbState.staleAsset = null;
	dbState.enqueueId = 99;
	dbState.claim = [];
	dbState.calls = [];
	payState.result = null;
	payState.lastArgs = null;
	payX402.mockClear();
});

describe('thumbnailKeyFor', () => {
	it('is deterministic, slug-safe, and run-scoped', () => {
		const k = thumbnailKeyFor('pole-dancer-rumba', 'abcdef0123456789');
		expect(k).toBe('thumbnails/assets/pole-dancer-rumba-abcdef01.png');
	});
	it('sanitizes unsafe slug characters', () => {
		const k = thumbnailKeyFor('weird/slug name!', 'run');
		expect(k).toMatch(/^thumbnails\/assets\/weird-slug-name--run\.png$/);
	});
});

describe('runThumbnailRegen — guards', () => {
	it('skips gracefully when the Solana context (wallet) is unavailable', async () => {
		const out = await runThumbnailRegen({ origin: 'https://three.ws' });
		expect(out.skipped).toBe(true);
		expect(out.success).toBe(false);
		expect(out.amountAtomic).toBe(0);
		expect(payX402).not.toHaveBeenCalled();
	});

	it('skips (no spend) when nothing is stale', async () => {
		dbState.staleAsset = null;
		const out = await runThumbnailRegen(SOLANA_CTX);
		expect(out.skipped).toBe(true);
		expect(out.success).toBe(true);
		expect(out.note).toBe('no_stale_assets');
		expect(payX402).not.toHaveBeenCalled();
	});
});

describe('runThumbnailRegen — happy path', () => {
	it('pays asset-download for the stale slug and queues a regen job', async () => {
		dbState.staleAsset = ASSET;
		payState.result = {
			success: true, paid: true, free: false, skipped: false,
			amountAtomic: 5000, txSig: 'TxSig123', status: 200,
			responseBody: { ok: true, slug: ASSET.slug, sizeBytes: 6_492_840, downloadUrl: 'https://r2.dev/x?sig=secret' },
		};

		const out = await runThumbnailRegen(SOLANA_CTX);

		// Paid the correct per-asset URL via GET.
		expect(payX402).toHaveBeenCalledTimes(1);
		expect(payState.lastArgs.method).toBe('GET');
		expect(payState.lastArgs.url).toBe(`https://three.ws${THUMBNAIL_REGEN_ENDPOINT}?slug=${ASSET.slug}`);
		expect(payState.lastArgs.remainingCap).toBe(SOLANA_CTX.remainingCap);

		// Outcome reflects a real settlement + queued job.
		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(5000);
		expect(out.txSig).toBe('TxSig123');
		expect(out.signalData.job_id).toBe(99);
		expect(out.signalData.downloaded).toBe(true);
		expect(out.note).toContain('queued regen');

		// The short-lived presigned URL is never persisted verbatim.
		expect(out.responseData.download_url).toBe('[presigned]');
		expect(JSON.stringify(out)).not.toContain('secret');

		// A regen job INSERT happened.
		const insert = dbState.calls.find((c) => /INSERT\s+INTO\s+avatar_thumbnail_regen_jobs/i.test(c.text));
		expect(insert).toBeTruthy();
	});

	it('counts no spend and does not enqueue when payment fails (402 reject)', async () => {
		dbState.staleAsset = ASSET;
		payState.result = {
			success: false, paid: false, free: false, skipped: false,
			amountAtomic: 5000, txSig: null, status: 402,
			responseBody: { error: 'verify_failed' }, errorMsg: 'http_402',
		};

		const out = await runThumbnailRegen(SOLANA_CTX);

		expect(out.success).toBe(false);
		expect(out.amountAtomic).toBe(0); // only on-chain settlement counts
		expect(out.errorMsg).toContain('http_402');
		const insert = dbState.calls.find((c) => /INSERT\s+INTO\s+avatar_thumbnail_regen_jobs/i.test(c.text));
		expect(insert).toBeFalsy();
	});

	it('never throws when payX402 throws (network fault)', async () => {
		dbState.staleAsset = ASSET;
		payState.result = new Error('ECONNRESET');
		const out = await runThumbnailRegen(SOLANA_CTX);
		expect(out.success).toBe(false);
		expect(out.errorMsg).toContain('pay_failed');
		expect(out.amountAtomic).toBe(0);
	});

	it('reports a duplicate (in-flight) job as job=dup without failing', async () => {
		dbState.staleAsset = ASSET;
		dbState.enqueueId = null; // ON CONFLICT DO NOTHING → no id
		payState.result = {
			success: true, paid: true, amountAtomic: 5000, txSig: 'TxDup',
			status: 200, responseBody: { ok: true, slug: ASSET.slug, sizeBytes: 1 },
		};
		const out = await runThumbnailRegen(SOLANA_CTX);
		expect(out.success).toBe(true);
		expect(out.signalData.job_id).toBe(null);
		expect(out.note).toContain('job=dup');
	});
});

describe('enqueueRegenJob', () => {
	it('requires slug and r2_key', async () => {
		await expect(enqueueRegenJob({ asset: { slug: 'x' } })).rejects.toThrow(/r2_key/);
	});
	it('returns the inserted job id', async () => {
		dbState.enqueueId = 7;
		const id = await enqueueRegenJob({ asset: ASSET, runId: 'r', txSig: 't', amountAtomic: 5000, responseBody: { slug: ASSET.slug, sizeBytes: 10 } });
		expect(id).toBe(7);
	});
});

describe('constants', () => {
	it('targets asset-download with a sane staleness window', () => {
		expect(THUMBNAIL_REGEN_ENDPOINT).toBe('/api/x402/asset-download');
		expect(STALE_DAYS).toBe(30);
	});
});
