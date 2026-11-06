/**
 * Tests for mcp-server/src/tools/_material-core.js — the dependency-free thin
 * HTTP client the paid restyle_material stdio tool uses (mirrors
 * _studio-core.js's contract: never throw past a coded { ok:false, error }
 * envelope, so a tool handler never crashes on a provider hiccup).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
	vi.resetModules();
	global.fetch = vi.fn();
});

describe('runRestyleMaterial — instruction mode', () => {
	it('posts to the restyle action and shapes a successful response', async () => {
		global.fetch.mockResolvedValueOnce({
			status: 200,
			ok: true,
			json: async () => ({
				ok: true,
				glbUrl: 'https://three.ws/cdn/material-studio/restyle/abc.glb',
				sourceGlbUrl: 'https://three.ws/cdn/creations/src.glb',
				instruction: 'make it chrome',
				factors: { metallicFactor: 1, roughnessFactor: 0.05 },
				materialsEdited: 2,
				lineage: [{ index: 0 }, { index: 1 }],
				activeIndex: 1,
			}),
		});
		const { runRestyleMaterial } = await import('../../mcp-server/src/tools/_material-core.js');
		const result = await runRestyleMaterial({
			glb_url: 'https://three.ws/cdn/creations/src.glb',
			instruction: 'make it chrome',
		});

		expect(result.ok).toBe(true);
		expect(result.mode).toBe('restyle');
		expect(result.glbUrl).toBe('https://three.ws/cdn/material-studio/restyle/abc.glb');
		expect(result.materialsEdited).toBe(2);
		expect(result.activeIndex).toBe(1);
		expect(result.viewerUrl).toContain('/viewer?src=');

		const [url, init] = global.fetch.mock.calls[0];
		expect(url).toBe('https://three.ws/api/material-studio?action=restyle');
		expect(JSON.parse(init.body)).toMatchObject({
			glb_url: 'https://three.ws/cdn/creations/src.glb',
			instruction: 'make it chrome',
		});
	});

	it('maps a 503 into a coded not_configured error, never throwing', async () => {
		global.fetch.mockResolvedValueOnce({
			status: 503,
			ok: false,
			json: async () => ({ message: 'AI restyle is not configured on this deployment' }),
		});
		const { runRestyleMaterial } = await import('../../mcp-server/src/tools/_material-core.js');
		const result = await runRestyleMaterial({ glb_url: 'https://three.ws/x.glb', instruction: 'chrome' });
		expect(result).toEqual({
			ok: false,
			error: 'not_configured',
			message: 'AI restyle is not configured on this deployment',
		});
	});

	it('maps a network failure into a coded provider_error', async () => {
		global.fetch.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
		const { runRestyleMaterial } = await import('../../mcp-server/src/tools/_material-core.js');
		const result = await runRestyleMaterial({ glb_url: 'https://three.ws/x.glb', instruction: 'chrome' });
		expect(result.ok).toBe(false);
		expect(result.error).toBe('provider_error');
	});

	it('rejects a missing glb_url before ever calling fetch', async () => {
		const { runRestyleMaterial } = await import('../../mcp-server/src/tools/_material-core.js');
		const result = await runRestyleMaterial({ instruction: 'chrome' });
		expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe('runRestyleMaterial — variant mode (no instruction)', () => {
	it('posts to the variants action and adds a viewerUrl per variant', async () => {
		global.fetch.mockResolvedValueOnce({
			status: 200,
			ok: true,
			json: async () => ({
				ok: true,
				sourceGlbUrl: 'https://three.ws/cdn/creations/src.glb',
				preset: 'gold',
				seed: 7,
				count: 2,
				variants: [
					{ glbUrl: 'https://three.ws/cdn/material-studio/variants/1.glb', label: 'Gold 1', seed: 7 },
					{ glbUrl: 'https://three.ws/cdn/material-studio/variants/2.glb', label: 'Gold 2', seed: 8 },
				],
				lineage: [{ index: 0 }],
				activeIndex: 0,
			}),
		});
		const { runRestyleMaterial } = await import('../../mcp-server/src/tools/_material-core.js');
		const result = await runRestyleMaterial({
			glb_url: 'https://three.ws/cdn/creations/src.glb',
			preset: 'gold',
			seed: 7,
			count: 2,
		});

		expect(result.ok).toBe(true);
		expect(result.mode).toBe('variants');
		expect(result.variants).toHaveLength(2);
		expect(result.variants[0].viewerUrl).toContain('/viewer?src=');

		const [url, init] = global.fetch.mock.calls[0];
		expect(url).toBe('https://three.ws/api/material-studio?action=variants');
		expect(JSON.parse(init.body)).toMatchObject({ preset: 'gold', seed: 7, count: 2 });
	});
});
