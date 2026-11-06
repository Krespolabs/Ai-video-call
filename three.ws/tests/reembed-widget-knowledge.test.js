// Unit tests for scripts/reembed-widget-knowledge.mjs — the T3.2 migration
// that moves stored widget knowledge chunks into the free NIM embedding
// space. Runs the script's exported functions against an in-memory fake of
// the widget_knowledge_docs/_chunks tables, pinning the safety properties:
// idempotent resume via the per-row embedder tag, atomic per-set tag flip,
// 429 backoff, and a write-free dry-run plan.

import { describe, it, expect, vi } from 'vitest';

import {
	parseCliArgs,
	classifyDoc,
	planMigration,
	migrateDoc,
	withBackoff,
	summarizePlan,
} from '../scripts/reembed-widget-knowledge.mjs';

const TARGET = 'nvidia/nv-embedqa-e5-v5@1024';
const LEGACY = 'text-embedding-3-small@256';

// ── In-memory fake of the two tables, routed on the SQL text ────────────────

function makeFakeDb({ docs = [], chunks = [] } = {}) {
	const state = {
		docs: docs.map((d) => ({ ...d })),
		chunks: chunks.map((c) => ({ ...c })),
		writes: 0,
	};

	const sql = async (strings, ...params) => {
		const text = strings.join('?').replace(/\s+/g, ' ');

		if (text.includes('select d.id, d.widget_id')) {
			// planMigration survey: params [targetTag, targetTag, widgetId, widgetId]
			const [targetTag, , widgetId] = params;
			return state.docs
				.filter((d) => widgetId == null || d.widget_id === widgetId)
				.map((d) => {
					const mine = state.chunks.filter((c) => c.doc_id === d.id);
					const pending = mine.filter((c) => c.embedder !== targetTag);
					return {
						id: d.id,
						widget_id: d.widget_id,
						title: d.title,
						status: d.status,
						doc_embedder: d.embedder,
						total_chunks: mine.length,
						pending_chunks: pending.length,
						pending_tokens: pending.reduce((s, c) => s + (c.token_count || 0), 0),
					};
				});
		}

		if (text.includes('select id, content from widget_knowledge_chunks')) {
			const [docId, targetTag, limit] = params;
			return state.chunks
				.filter((c) => c.doc_id === docId && c.embedder !== targetTag)
				.sort((a, b) => a.chunk_index - b.chunk_index)
				.slice(0, limit)
				.map((c) => ({ id: c.id, content: c.content }));
		}

		if (text.includes('update widget_knowledge_chunks')) {
			const [vecJson, targetTag, id] = params;
			const row = state.chunks.find((c) => c.id === id);
			row.embedding = JSON.parse(vecJson);
			row.embedder = targetTag;
			state.writes++;
			return [];
		}

		if (text.includes('select count(*)::int as remaining')) {
			const [docId, targetTag] = params;
			const remaining = state.chunks.filter(
				(c) => c.doc_id === docId && c.embedder !== targetTag,
			).length;
			return [{ remaining }];
		}

		if (text.includes('update widget_knowledge_docs set embedder')) {
			const [targetTag, docId] = params;
			state.docs.find((d) => d.id === docId).embedder = targetTag;
			state.writes++;
			return [];
		}

		throw new Error(`fake db: unrecognized query: ${text.slice(0, 80)}`);
	};

	return { sql, state };
}

function legacyChunk(id, docId, index) {
	return {
		id,
		doc_id: docId,
		chunk_index: index,
		content: `chunk ${index} content`,
		embedding: [0.1, 0.2],
		token_count: 10,
		embedder: LEGACY,
	};
}

const fakeEmbed = vi.fn(async (texts) => texts.map(() => Float64Array.from([1, 0, 0])));
const noSleep = vi.fn(async () => {});

describe('parseCliArgs', () => {
	it('parses the supported flags and applies safe defaults', () => {
		expect(parseCliArgs([])).toEqual({ dryRun: false, widget: null, batch: 64, throttleMs: 400 });
		expect(parseCliArgs(['--dry-run', '--widget', 'wdgt_x', '--batch', '8', '--throttle-ms', '0']))
			.toEqual({ dryRun: true, widget: 'wdgt_x', batch: 8, throttleMs: 0 });
	});

	it('rejects unknown flags instead of silently ignoring them', () => {
		expect(() => parseCliArgs(['--nuke'])).toThrow(/unknown argument/);
	});

	it('clamps batch size to the probed 512-input ceiling', () => {
		expect(parseCliArgs(['--batch', '4096']).batch).toBe(512);
	});
});

describe('classifyDoc', () => {
	it('skips non-ready docs with a reason', () => {
		expect(classifyDoc({ status: 'failed', total_chunks: 3, pending_chunks: 3 }, TARGET))
			.toEqual({ action: 'skip', reason: 'status=failed' });
	});

	it('skips empty docs', () => {
		expect(classifyDoc({ status: 'ready', total_chunks: 0, pending_chunks: 0 }, TARGET).action)
			.toBe('skip');
	});

	it('recognizes fully migrated sets (idempotent re-run)', () => {
		expect(
			classifyDoc(
				{ status: 'ready', total_chunks: 3, pending_chunks: 0, doc_embedder: TARGET },
				TARGET,
			).action,
		).toBe('done');
	});

	it('flips the stale doc tag when all chunks migrated but a crash skipped the flip', () => {
		expect(
			classifyDoc(
				{ status: 'ready', total_chunks: 3, pending_chunks: 0, doc_embedder: LEGACY },
				TARGET,
			).action,
		).toBe('flip');
	});

	it('migrates docs with pending chunks', () => {
		expect(
			classifyDoc(
				{ status: 'ready', total_chunks: 3, pending_chunks: 2, doc_embedder: LEGACY },
				TARGET,
			).action,
		).toBe('migrate');
	});
});

describe('planMigration + summarizePlan (dry-run path)', () => {
	it('surveys without writing and produces honest counts and estimates', async () => {
		const { sql, state } = makeFakeDb({
			docs: [
				{ id: 'wkd_a', widget_id: 'w1', title: 'A', status: 'ready', embedder: LEGACY },
				{ id: 'wkd_b', widget_id: 'w1', title: 'B', status: 'ready', embedder: TARGET },
				{ id: 'wkd_c', widget_id: 'w2', title: 'C', status: 'failed', embedder: LEGACY },
			],
			chunks: [
				legacyChunk(1, 'wkd_a', 0),
				legacyChunk(2, 'wkd_a', 1),
				{ ...legacyChunk(3, 'wkd_b', 0), embedder: TARGET },
				legacyChunk(4, 'wkd_c', 0),
			],
		});

		const plan = await planMigration(sql, { targetTag: TARGET });
		const totals = summarizePlan(plan, { batch: 64, throttleMs: 0 });

		expect(totals).toMatchObject({ docs: 3, migrate: 1, done: 1, skip: 1, flip: 0 });
		// Skipped docs still report pending chunks in the survey, but only the
		// 'migrate' doc contributes work; the failed doc is listed with a reason.
		expect(plan.find((d) => d.id === 'wkd_c')).toMatchObject({
			action: 'skip',
			reason: 'status=failed',
		});
		expect(state.writes).toBe(0); // dry-run writes NOTHING
	});

	it('scopes to a single widget when asked', async () => {
		const { sql } = makeFakeDb({
			docs: [
				{ id: 'wkd_a', widget_id: 'w1', title: 'A', status: 'ready', embedder: LEGACY },
				{ id: 'wkd_b', widget_id: 'w2', title: 'B', status: 'ready', embedder: LEGACY },
			],
			chunks: [legacyChunk(1, 'wkd_a', 0), legacyChunk(2, 'wkd_b', 0)],
		});
		const plan = await planMigration(sql, { targetTag: TARGET, widgetId: 'w2' });
		expect(plan.map((d) => d.id)).toEqual(['wkd_b']);
	});
});

describe('migrateDoc — idempotent, resume-safe, atomic per set', () => {
	it('re-embeds only pending chunks and flips the doc tag at the end', async () => {
		const { sql, state } = makeFakeDb({
			docs: [{ id: 'wkd_a', widget_id: 'w1', title: 'A', status: 'ready', embedder: LEGACY }],
			chunks: [
				legacyChunk(1, 'wkd_a', 0),
				{ ...legacyChunk(2, 'wkd_a', 1), embedder: TARGET, embedding: [9, 9, 9] }, // already migrated
				legacyChunk(3, 'wkd_a', 2),
			],
		});
		fakeEmbed.mockClear();

		const result = await migrateDoc(
			{ sql, embedBatchFn: fakeEmbed, sleep: noSleep },
			{ id: 'wkd_a' },
			{ targetTag: TARGET, batch: 64, throttleMs: 0 },
		);

		expect(result).toEqual({ migrated: 2, flipped: true });
		// Only the 2 pending chunks were embedded — the migrated row was untouched.
		expect(fakeEmbed).toHaveBeenCalledTimes(1);
		expect(fakeEmbed.mock.calls[0][0]).toEqual(['chunk 0 content', 'chunk 2 content']);
		expect(state.chunks.find((c) => c.id === 2).embedding).toEqual([9, 9, 9]);
		expect(state.chunks.every((c) => c.embedder === TARGET)).toBe(true);
		expect(state.docs[0].embedder).toBe(TARGET);
	});

	it('a crash mid-set leaves the doc tag unflipped and a re-run completes the rest', async () => {
		const { sql, state } = makeFakeDb({
			docs: [{ id: 'wkd_a', widget_id: 'w1', title: 'A', status: 'ready', embedder: LEGACY }],
			chunks: [legacyChunk(1, 'wkd_a', 0), legacyChunk(2, 'wkd_a', 1)],
		});

		// Batch size 1 → two embed calls; the second one dies hard (non-retryable).
		const dyingEmbed = vi
			.fn()
			.mockResolvedValueOnce([Float64Array.from([1, 0, 0])])
			.mockRejectedValue(Object.assign(new Error('invalid key'), { status: 401 }));

		await expect(
			migrateDoc(
				{ sql, embedBatchFn: dyingEmbed, sleep: noSleep },
				{ id: 'wkd_a' },
				{ targetTag: TARGET, batch: 1, throttleMs: 0 },
			),
		).rejects.toThrow('invalid key');

		// First chunk migrated, second untouched, set tag NOT flipped — retrieval
		// keeps routing each chunk in its own (correct) space meanwhile.
		expect(state.chunks.find((c) => c.id === 1).embedder).toBe(TARGET);
		expect(state.chunks.find((c) => c.id === 2).embedder).toBe(LEGACY);
		expect(state.docs[0].embedder).toBe(LEGACY);

		// Resume: a fresh run embeds ONLY the remaining chunk, then flips.
		const resumeEmbed = vi.fn(async (texts) => texts.map(() => Float64Array.from([0, 1, 0])));
		const result = await migrateDoc(
			{ sql, embedBatchFn: resumeEmbed, sleep: noSleep },
			{ id: 'wkd_a' },
			{ targetTag: TARGET, batch: 1, throttleMs: 0 },
		);
		expect(result).toEqual({ migrated: 1, flipped: true });
		expect(resumeEmbed).toHaveBeenCalledTimes(1);
		expect(resumeEmbed.mock.calls[0][0]).toEqual(['chunk 1 content']);
		expect(state.docs[0].embedder).toBe(TARGET);
	});

	it('re-running over a fully migrated set embeds nothing (idempotent)', async () => {
		const { sql } = makeFakeDb({
			docs: [{ id: 'wkd_a', widget_id: 'w1', title: 'A', status: 'ready', embedder: TARGET }],
			chunks: [{ ...legacyChunk(1, 'wkd_a', 0), embedder: TARGET }],
		});
		const embed = vi.fn();
		const result = await migrateDoc(
			{ sql, embedBatchFn: embed, sleep: noSleep },
			{ id: 'wkd_a' },
			{ targetTag: TARGET, batch: 64, throttleMs: 0 },
		);
		expect(result).toEqual({ migrated: 0, flipped: true });
		expect(embed).not.toHaveBeenCalled();
	});
});

describe('withBackoff — free-tier rate-limit handling', () => {
	it('backs off exponentially on 429 and then succeeds', async () => {
		const sleep = vi.fn(async () => {});
		const fn = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
			.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
			.mockResolvedValue('ok');

		const out = await withBackoff(fn, { sleep, baseMs: 100 });
		expect(out).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		// Exponential: second delay ≥ 2× base, both within jitter bounds.
		expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(100);
		expect(sleep.mock.calls[1][0]).toBeGreaterThanOrEqual(200);
	});

	it('retries network-level failures (no status)', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('fetch failed'))
			.mockResolvedValue('ok');
		expect(await withBackoff(fn, { sleep: noSleep, baseMs: 1 })).toBe('ok');
	});

	it('does NOT retry hard 4xx or configuration errors', async () => {
		const bad = vi.fn().mockRejectedValue(Object.assign(new Error('bad key'), { status: 401 }));
		await expect(withBackoff(bad, { sleep: noSleep })).rejects.toThrow('bad key');
		expect(bad).toHaveBeenCalledTimes(1);

		const unconfigured = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error('no key'), { code: 'no_embedder' }));
		await expect(withBackoff(unconfigured, { sleep: noSleep })).rejects.toThrow('no key');
		expect(unconfigured).toHaveBeenCalledTimes(1);
	});

	it('gives up after the attempt budget', async () => {
		const always429 = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
		await expect(withBackoff(always429, { sleep: noSleep, attempts: 3, baseMs: 1 })).rejects.toThrow(
			'rate limited',
		);
		expect(always429).toHaveBeenCalledTimes(3);
	});
});
