import { describe, it, expect, beforeEach, vi } from 'vitest';

import { runRestyleMaterial } from '../mcp-server/src/tools/_material-core.js';

// `restyle_material` (mcp-server/src/tools/restyle-material.js) is a thin,
// fetch-only client over the hosted, free api/material-studio endpoint — the
// SAME implementation the free web Restyle Studio page calls. These tests pin
// down runRestyleMaterial's request shaping and response mapping without any
// network, DB, or LLM call: they stub global.fetch and assert what gets sent
// and how the response (including the parent → child version lineage) comes
// back out.

function res(status, body = {}) {
	return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('runRestyleMaterial — input validation', () => {
	it('rejects a missing glb_url before any network call', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const out = await runRestyleMaterial({ instruction: 'make it chrome' });
		expect(out.ok).toBe(false);
		expect(out.error).toBe('invalid_input');
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

describe('runRestyleMaterial — instruction (restyle) mode', () => {
	let fetchMock;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('posts to the restyle action and forwards parent_lineage/parent_index', async () => {
		const lineage = [
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/a.glb', refKind: 'origin' },
		];
		fetchMock.mockResolvedValueOnce(
			res(200, {
				ok: true,
				glbUrl: 'https://three.ws/cdn/material-studio/restyle/def.glb',
				sourceGlbUrl: 'https://three.ws/cdn/a.glb',
				instruction: 'make it chrome',
				factors: { name: 'Polished chrome', metallicFactor: 1, roughnessFactor: 0.05 },
				materialsEdited: 1,
				lineage: [...lineage, { index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/material-studio/restyle/def.glb', instruction: 'make it chrome', refKind: 'restyle' }],
				activeIndex: 1,
			}),
		);

		const out = await runRestyleMaterial({
			glb_url: 'https://three.ws/cdn/a.glb',
			instruction: 'make it chrome',
			parent_lineage: lineage,
			parent_index: 0,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://three.ws/api/material-studio?action=restyle');
		const body = JSON.parse(init.body);
		expect(body).toMatchObject({
			glb_url: 'https://three.ws/cdn/a.glb',
			instruction: 'make it chrome',
			parent_lineage: lineage,
			parent_index: 0,
		});

		expect(out.ok).toBe(true);
		expect(out.mode).toBe('restyle');
		expect(out.glbUrl).toBe('https://three.ws/cdn/material-studio/restyle/def.glb');
		expect(out.activeIndex).toBe(1);
		expect(out.lineage).toHaveLength(2);
		expect(out.viewerUrl).toContain(encodeURIComponent(out.glbUrl));
	});

	it('surfaces a not_configured (503) upstream error as a stable error code', async () => {
		fetchMock.mockResolvedValueOnce(res(503, { ok: false, message: 'AI restyle is not configured on this deployment' }));
		const out = await runRestyleMaterial({ glb_url: 'https://three.ws/cdn/a.glb', instruction: 'make it wood' });
		expect(out.ok).toBe(false);
		expect(out.error).toBe('not_configured');
		expect(out.message).toMatch(/not configured/i);
	});

	it('surfaces a rate-limited (429) upstream error as a stable error code', async () => {
		fetchMock.mockResolvedValueOnce(res(429, { ok: false, message: 'material studio is busy; try again shortly' }));
		const out = await runRestyleMaterial({ glb_url: 'https://three.ws/cdn/a.glb', instruction: 'make it gold' });
		expect(out.ok).toBe(false);
		expect(out.error).toBe('rate_limited');
	});
});

describe('runRestyleMaterial — variant (preset/seed/count) mode', () => {
	let fetchMock;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('posts to the variants action when instruction is omitted, and maps viewerUrl + lineage per variant', async () => {
		fetchMock.mockResolvedValueOnce(
			res(200, {
				ok: true,
				sourceGlbUrl: 'https://three.ws/cdn/a.glb',
				preset: 'chrome',
				seed: 42,
				count: 2,
				variants: [
					{ glbUrl: 'https://three.ws/cdn/v1.glb', label: 'Chrome 1', seed: 42, config: {}, lineageIndex: 1 },
					{ glbUrl: 'https://three.ws/cdn/v2.glb', label: 'Chrome 2', seed: 43, config: {}, lineageIndex: 2 },
				],
				lineage: [
					{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/a.glb', refKind: 'origin' },
					{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/v1.glb', refKind: 'variant' },
					{ index: 2, parentIndex: 0, glbUrl: 'https://three.ws/cdn/v2.glb', refKind: 'variant' },
				],
				activeIndex: 0,
			}),
		);

		const out = await runRestyleMaterial({
			glb_url: 'https://three.ws/cdn/a.glb',
			preset: 'chrome',
			seed: 42,
			count: 2,
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://three.ws/api/material-studio?action=variants');
		const body = JSON.parse(init.body);
		expect(body).toMatchObject({ glb_url: 'https://three.ws/cdn/a.glb', preset: 'chrome', seed: 42, count: 2 });

		expect(out.ok).toBe(true);
		expect(out.mode).toBe('variants');
		expect(out.variants).toHaveLength(2);
		expect(out.variants[0].viewerUrl).toContain(encodeURIComponent('https://three.ws/cdn/v1.glb'));
		expect(out.lineage).toHaveLength(3);
		expect(out.activeIndex).toBe(0);
	});
});
