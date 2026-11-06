// Tests for api/_lib/rerank.js — the optional NIM rerank stage behind
// KNOWLEDGE_RERANK_ENABLED. Pins the two contracts retrieval depends on:
// opt-in gating (retrieval ordering never changes without the flag) and
// strict fail-open (any upstream problem returns null so cosine order wins).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { rerankConfigured, rerankPassages } from '../../api/_lib/rerank.js';

const fetchMock = vi.fn();

function clearEnv() {
	delete process.env.KNOWLEDGE_RERANK_ENABLED;
	delete process.env.NVIDIA_API_KEY;
}

beforeEach(() => {
	clearEnv();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearEnv();
});

function enable() {
	process.env.KNOWLEDGE_RERANK_ENABLED = '1';
	process.env.NVIDIA_API_KEY = 'nvapi-test';
}

describe('rerankConfigured', () => {
	it('is off by default, even with the NVIDIA key present', () => {
		expect(rerankConfigured()).toBe(false);
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		expect(rerankConfigured()).toBe(false);
	});

	it('requires BOTH the opt-in flag and the key', () => {
		process.env.KNOWLEDGE_RERANK_ENABLED = '1';
		expect(rerankConfigured()).toBe(false);
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		expect(rerankConfigured()).toBe(true);
	});
});

describe('rerankPassages', () => {
	it('returns null without touching the network when not configured', async () => {
		expect(await rerankPassages('q', ['a', 'b'])).toBe(null);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('posts the probed body shape and returns candidate indexes best-first', async () => {
		enable();
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				rankings: [
					{ index: 2, logit: 3.7 },
					{ index: 0, logit: -1.2 },
					{ index: 1, logit: -14.6 },
				],
			}),
		});
		const order = await rerankPassages('capital of France?', ['p0', 'p1', 'p2']);
		expect(order).toEqual([2, 0, 1]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking');
		expect(JSON.parse(init.body)).toEqual({
			model: 'nvidia/rerank-qa-mistral-4b',
			query: { text: 'capital of France?' },
			passages: [{ text: 'p0' }, { text: 'p1' }, { text: 'p2' }],
		});
	});

	it('skips degenerate inputs (fewer than two passages)', async () => {
		enable();
		expect(await rerankPassages('q', ['only one'])).toBe(null);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fails open on an upstream error status', async () => {
		enable();
		fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
		expect(await rerankPassages('q', ['a', 'b'])).toBe(null);
	});

	it('fails open on a network throw', async () => {
		enable();
		fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
		expect(await rerankPassages('q', ['a', 'b'])).toBe(null);
	});

	it('rejects a partial or garbled ranking instead of reordering with it', async () => {
		enable();
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ rankings: [{ index: 0, logit: 1 }, { index: 7, logit: 0 }] }),
		});
		expect(await rerankPassages('q', ['a', 'b'])).toBe(null);
	});
});
