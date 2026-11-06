import { describe, it, expect } from 'vitest';

import {
	buildRequestBody,
	summarizeResult,
	nextRotation,
	SEED_ROTATION,
	REFERENCE_AVATARS,
} from '../api/_lib/x402/pipelines/live-feed-seeder.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

// The demo flow only accepts these tools (ALLOWED_TOOLS in api/x402-pay.js).
const ALLOWED_TOOLS = new Set([
	'tools/list',
	'validate_model',
	'inspect_model',
	'optimize_model',
	'search_public_avatars',
]);

describe('live-feed-seeder — rotation', () => {
	it('every rotation entry targets an allowed demo tool', () => {
		expect(SEED_ROTATION.length).toBeGreaterThan(0);
		for (const pick of SEED_ROTATION) {
			expect(ALLOWED_TOOLS.has(pick.tool)).toBe(true);
			expect(typeof pick.topic).toBe('string');
			expect(pick.topic.length).toBeGreaterThan(0);
		}
	});

	it('shows variety — more than one distinct tool across the rotation', () => {
		const tools = new Set(SEED_ROTATION.map((p) => p.tool));
		expect(tools.size).toBeGreaterThan(1);
	});

	it('round-robins through the whole list and wraps (in-memory fallback)', async () => {
		const seen = [];
		for (let i = 0; i < SEED_ROTATION.length * 2; i++) seen.push(await nextRotation({}));
		// First full cycle covers every entry exactly once.
		const firstCycle = seen.slice(0, SEED_ROTATION.length);
		expect(new Set(firstCycle).size).toBe(SEED_ROTATION.length);
		// Then it wraps back to the start.
		expect(seen[SEED_ROTATION.length]).toBe(seen[0]);
	});
});

describe('live-feed-seeder — buildRequestBody', () => {
	it('builds a model-tool body with a public https avatar url', () => {
		const body = buildRequestBody({ tool: 'inspect_model', avatar: 'michelle.glb' }, 'https://three.ws');
		expect(body).toEqual({ tool: 'inspect_model', args: { url: 'https://three.ws/avatars/michelle.glb' } });
		expect(/^https:\/\//.test(body.args.url)).toBe(true);
	});

	it('passes through search args verbatim', () => {
		const body = buildRequestBody({ tool: 'search_public_avatars', args: { q: 'robot', limit: 6 } }, 'https://three.ws');
		expect(body).toEqual({ tool: 'search_public_avatars', args: { q: 'robot', limit: 6 } });
	});

	it('tools/list carries an empty args object', () => {
		expect(buildRequestBody({ tool: 'tools/list', args: {} }, 'https://three.ws')).toEqual({ tool: 'tools/list', args: {} });
	});

	it('every avatar-backed rotation entry references a known reference avatar', () => {
		for (const pick of SEED_ROTATION) {
			if (pick.avatar) expect(REFERENCE_AVATARS).toContain(pick.avatar);
		}
	});
});

describe('live-feed-seeder — summarizeResult', () => {
	it('summarizes an avatar search by hit count', () => {
		expect(summarizeResult('search_public_avatars', { structuredContent: { avatars: [1, 2, 3] } }))
			.toEqual({ result_kind: 'avatars', result_count: 3 });
	});

	it('summarizes an inspection by geometry headline', () => {
		expect(summarizeResult('inspect_model', { structuredContent: { counts: { totalTriangles: 5000, meshes: 2 } } }))
			.toEqual({ result_kind: 'inspection', triangles: 5000, meshes: 2 });
	});

	it('summarizes a validation by error/warning counts', () => {
		expect(summarizeResult('validate_model', { structuredContent: { numErrors: 0, numWarnings: 3 } }))
			.toEqual({ result_kind: 'validation', errors: 0, warnings: 3 });
	});

	it('summarizes an optimization by suggestion count', () => {
		expect(summarizeResult('optimize_model', { structuredContent: { suggestions: [1, 2] } }))
			.toEqual({ result_kind: 'optimization', suggestions: 2 });
	});

	it('summarizes tools/list by tool count', () => {
		expect(summarizeResult('tools/list', { tools: [1, 2, 3, 4, 5] }))
			.toEqual({ result_kind: 'tools', tools: 5 });
	});

	it('never throws on a missing/garbage result', () => {
		expect(summarizeResult('inspect_model', null)).toEqual({ result_kind: 'inspection', triangles: null, meshes: null });
		expect(summarizeResult('search_public_avatars', {})).toEqual({ result_kind: 'avatars', result_count: null });
	});
});

describe('live-feed-seeder — registry wiring', () => {
	it('is registered as an enabled run()-style entry with a frequent cooldown', () => {
		const entry = getFullRegistry().find((e) => e.id === 'live-feed-seeder');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(typeof entry.run).toBe('function');
		expect(entry.path).toBe('/api/x402-pay');
		expect(entry.pipeline).toBe('feed');
		// Loop ticks every 5 min — a 300s cooldown keeps the feed fresh each tick.
		expect(entry.cooldown_s).toBeLessThanOrEqual(300);
	});
});
