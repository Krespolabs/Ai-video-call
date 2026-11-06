import { describe, it, expect } from 'vitest';

import {
	normalizeInstruction,
	composeRefinement,
	seedLineage,
	appendVersion,
	branchFrom,
	revertTo,
	buildLineageChain,
	summarizeLineage,
} from '../mcp-server/src/tools/_lineage.js';

describe('normalizeInstruction', () => {
	it('strips leading imperative filler', () => {
		expect(normalizeInstruction('make it metallic')).toBe('metallic');
		expect(normalizeInstruction('now add wings')).toBe('add wings');
		expect(normalizeInstruction('please make the helmet bigger')).toBe('helmet bigger');
		expect(normalizeInstruction('turn it into a robot')).toBe('robot');
	});

	it('collapses whitespace and trims trailing punctuation', () => {
		expect(normalizeInstruction('  make   it   gold.  ')).toBe('gold');
	});

	it('keeps a payload that has no filler prefix', () => {
		expect(normalizeInstruction('glossy red plastic')).toBe('glossy red plastic');
	});

	it('returns pure-filler instructions unchanged rather than empty', () => {
		expect(normalizeInstruction('make it')).toBe('make it');
	});

	it('handles empty / nullish input', () => {
		expect(normalizeInstruction('')).toBe('');
		expect(normalizeInstruction(null)).toBe('');
		expect(normalizeInstruction(undefined)).toBe('');
	});
});

describe('composeRefinement', () => {
	it('anchors the change onto the carried-forward parent prompt', () => {
		expect(composeRefinement('a round robot mascot', 'make it metallic')).toBe(
			'a round robot mascot, metallic',
		);
	});

	it('is deterministic — same inputs give the same prompt', () => {
		const a = composeRefinement('a knight helmet', 'make the helmet bigger');
		const b = composeRefinement('a knight helmet', 'make the helmet bigger');
		expect(a).toBe(b);
		expect(a).toBe('a knight helmet, helmet bigger');
	});

	it('falls back to the instruction alone when the parent prompt is unknown', () => {
		expect(composeRefinement('', 'add wings')).toBe('add wings');
		expect(composeRefinement(null, 'make it golden')).toBe('golden');
	});

	it('falls back to the parent prompt when the instruction is empty', () => {
		expect(composeRefinement('a brass lantern', '')).toBe('a brass lantern');
	});

	it('caps the composed prompt at the generator limit (1000 chars)', () => {
		const long = 'x'.repeat(1200);
		expect(composeRefinement(long, 'make it blue').length).toBe(1000);
	});
});

describe('version lineage integrity', () => {
	it('seeds an origin version at index 0 with no parent', () => {
		const lin = seedLineage({ glbUrl: 'https://three.ws/a.glb', prompt: 'a robot' });
		expect(lin).toHaveLength(1);
		expect(lin[0]).toMatchObject({ index: 0, parentIndex: null, refKind: 'origin' });
	});

	it('appends children that chain parent → child and never mutates history', () => {
		const v0 = seedLineage({ glbUrl: 'g0', prompt: 'a robot' });
		const v1 = appendVersion(v0, { glbUrl: 'g1', prompt: 'a robot, metallic', instruction: 'metallic' });
		const v2 = appendVersion(v1, { glbUrl: 'g2', prompt: 'a robot, metallic, wings', instruction: 'add wings' });

		expect(v0).toHaveLength(1); // original untouched (immutable)
		expect(v1).toHaveLength(2);
		expect(v2).toHaveLength(3);
		expect(v1[1]).toMatchObject({ index: 1, parentIndex: 0, instruction: 'metallic' });
		expect(v2[2]).toMatchObject({ index: 2, parentIndex: 1, instruction: 'add wings' });
	});

	it('validates a clean linear lineage and returns the root→leaf chain', () => {
		let lin = seedLineage({ glbUrl: 'g0' });
		lin = appendVersion(lin, { glbUrl: 'g1', instruction: 'metallic' });
		lin = appendVersion(lin, { glbUrl: 'g2', instruction: 'wings' });
		const res = buildLineageChain(lin);
		expect(res.ok).toBe(true);
		expect(res.errors).toEqual([]);
		expect(res.roots).toEqual([0]);
		expect(res.leaves).toEqual([2]);
		expect(res.chain.map((v) => v.index)).toEqual([0, 1, 2]);
	});

	it('supports branching — a tree with two leaves, each chain valid', () => {
		let lin = seedLineage({ glbUrl: 'g0' });
		lin = appendVersion(lin, { glbUrl: 'g1', instruction: 'metallic' }); // index 1, parent 0
		// Branch off the ORIGINAL (index 0), not the latest.
		lin = appendVersion(lin, { glbUrl: 'g2', instruction: 'wooden', parentIndex: branchFrom(lin, 0) });

		expect(lin[2]).toMatchObject({ index: 2, parentIndex: 0 });
		const res = buildLineageChain(lin);
		expect(res.ok).toBe(true);
		expect(res.leaves.sort()).toEqual([1, 2]);
		// Active defaults to the highest index (2); its chain skips the sibling.
		expect(res.chain.map((v) => v.index)).toEqual([0, 2]);
	});

	it('reverts to an earlier version without mutating history', () => {
		let lin = seedLineage({ glbUrl: 'g0' });
		lin = appendVersion(lin, { glbUrl: 'g1', instruction: 'metallic' });
		lin = appendVersion(lin, { glbUrl: 'g2', instruction: 'wings' });
		const { activeIndex, active } = revertTo(lin, 1);
		expect(activeIndex).toBe(1);
		expect(active.glbUrl).toBe('g1');
		expect(lin).toHaveLength(3); // history intact

		const res = buildLineageChain(lin, 1);
		expect(res.chain.map((v) => v.index)).toEqual([0, 1]);
	});

	it('rejects reverting / branching to a non-existent version', () => {
		const lin = seedLineage({ glbUrl: 'g0' });
		expect(() => revertTo(lin, 5)).toThrow();
		expect(() => branchFrom(lin, 5)).toThrow();
	});

	it('detects a broken parent reference', () => {
		const bad = [
			{ index: 0, parentIndex: null, glbUrl: 'g0', refKind: 'origin' },
			{ index: 1, parentIndex: 7, glbUrl: 'g1', refKind: 'text' },
		];
		const res = buildLineageChain(bad);
		expect(res.ok).toBe(false);
		expect(res.errors.join(' ')).toMatch(/missing parent 7/);
	});

	it('detects a forward/cyclic parent reference', () => {
		const bad = [
			{ index: 0, parentIndex: 1, glbUrl: 'g0', refKind: 'origin' },
			{ index: 1, parentIndex: 0, glbUrl: 'g1', refKind: 'text' },
		];
		const res = buildLineageChain(bad);
		expect(res.ok).toBe(false);
		expect(res.errors.join(' ')).toMatch(/not earlier|root/);
	});

	it('detects a duplicate index', () => {
		const bad = [
			{ index: 0, parentIndex: null, glbUrl: 'g0', refKind: 'origin' },
			{ index: 0, parentIndex: null, glbUrl: 'gx', refKind: 'origin' },
		];
		expect(buildLineageChain(bad).ok).toBe(false);
	});

	it('summarizes a lineage for the version strip with the active flag set', () => {
		let lin = seedLineage({ glbUrl: 'g0', viewerUrl: 'v0', prompt: 'a robot' });
		lin = appendVersion(lin, { glbUrl: 'g1', viewerUrl: 'v1', instruction: 'metallic' });
		const strip = summarizeLineage(lin, 0);
		expect(strip).toHaveLength(2);
		expect(strip[0]).toMatchObject({ index: 0, label: 'Original', active: true });
		expect(strip[1]).toMatchObject({ index: 1, label: 'metallic', active: false });
	});
});
