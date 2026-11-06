import { describe, it, expect } from 'vitest';

import { resolveBaseLineage, resolveParentIndex, MaterialStudioError } from '../api/_lib/material-studio-store.js';

// Material Studio (api/_lib/material-studio-store.js) records every AI restyle
// and every persisted variant fan-out in the SAME immutable parent → child
// lineage shape refine_model uses (mcp-server/src/tools/_lineage.js). These
// tests guard the two small helpers that make that non-destructive: resolving
// the starting lineage for a call (fresh vs extended) and resolving which
// version a new one branches off of. Pure, dependency-free, no network/DB.

describe('resolveBaseLineage', () => {
	it('seeds a fresh single-version lineage when no parent lineage is supplied', () => {
		const lineage = resolveBaseLineage('https://three.ws/cdn/creations/abc.glb', undefined);
		expect(lineage).toHaveLength(1);
		expect(lineage[0]).toMatchObject({
			index: 0,
			parentIndex: null,
			glbUrl: 'https://three.ws/cdn/creations/abc.glb',
			refKind: 'origin',
		});
	});

	it('seeds fresh when parent lineage is an empty array', () => {
		const lineage = resolveBaseLineage('https://three.ws/cdn/creations/abc.glb', []);
		expect(lineage).toHaveLength(1);
		expect(lineage[0].refKind).toBe('origin');
	});

	it('rehydrates and extends a valid, well-formed parent lineage', () => {
		const parent = [
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/a.glb', refKind: 'origin' },
			{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/b.glb', instruction: 'make it chrome', refKind: 'restyle' },
		];
		const lineage = resolveBaseLineage('https://three.ws/cdn/a.glb', parent);
		expect(lineage).toHaveLength(2);
		expect(lineage[1]).toMatchObject({ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/b.glb', instruction: 'make it chrome' });
	});

	it('falls back to a fresh lineage rooted at the current url when the supplied one has a cycle', () => {
		// version 0 claims its parent is version 1, which claims its parent is 0 — a cycle.
		const malformed = [
			{ index: 0, parentIndex: 1, glbUrl: 'https://three.ws/cdn/a.glb' },
			{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/b.glb' },
		];
		const lineage = resolveBaseLineage('https://three.ws/cdn/current.glb', malformed);
		expect(lineage).toHaveLength(1);
		expect(lineage[0]).toMatchObject({ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/current.glb', refKind: 'origin' });
	});

	it('falls back to a fresh lineage when the supplied one has duplicate indices', () => {
		const malformed = [
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/a.glb' },
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/b.glb' },
		];
		const lineage = resolveBaseLineage('https://three.ws/cdn/current.glb', malformed);
		expect(lineage).toHaveLength(1);
		expect(lineage[0]).toMatchObject({ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/current.glb', refKind: 'origin' });
	});

	it('is not fooled by a non-array parent lineage (tampered client state)', () => {
		const lineage = resolveBaseLineage('https://three.ws/cdn/a.glb', { not: 'an array' });
		expect(lineage).toHaveLength(1);
	});
});

describe('resolveParentIndex', () => {
	const lineage = [
		{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/a.glb', refKind: 'origin' },
		{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/b.glb', refKind: 'restyle' },
		{ index: 2, parentIndex: 1, glbUrl: 'https://three.ws/cdn/c.glb', refKind: 'restyle' },
	];

	it('returns undefined when no index is given (defer to the leaf)', () => {
		expect(resolveParentIndex(lineage, undefined)).toBeUndefined();
	});

	it('returns undefined for a non-integer index', () => {
		expect(resolveParentIndex(lineage, 1.5)).toBeUndefined();
		expect(resolveParentIndex(lineage, '1')).toBeUndefined();
	});

	it('resolves a valid branch index', () => {
		expect(resolveParentIndex(lineage, 0)).toBe(0);
		expect(resolveParentIndex(lineage, 1)).toBe(1);
	});

	it('falls back to undefined for an out-of-range index rather than throwing', () => {
		expect(resolveParentIndex(lineage, 99)).toBeUndefined();
		expect(resolveParentIndex(lineage, -1)).toBeUndefined();
	});
});

describe('MaterialStudioError', () => {
	it('defaults to a 500 / material_studio_error and carries a message', () => {
		const err = new MaterialStudioError('boom');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('MaterialStudioError');
		expect(err.status).toBe(500);
		expect(err.code).toBe('material_studio_error');
		expect(err.message).toBe('boom');
	});

	it('carries a caller-supplied status and code', () => {
		const err = new MaterialStudioError('bad input', { status: 400, code: 'invalid_url' });
		expect(err.status).toBe(400);
		expect(err.code).toBe('invalid_url');
	});
});
