// Unit tests for api/_lib/embedding-math.js — the deterministic projection and
// clustering that lays out the IBM Granite Agent Galaxy. No network, no mocks:
// these pin the math contract the /api/ibm/galaxy endpoint depends on.

import { describe, it, expect } from 'vitest';
import {
	makeRng,
	dot,
	unit,
	cosineSimilarity,
	meanCenter,
	projectTo3D,
	kmeans,
	suggestClusterCount,
} from '../api/_lib/embedding-math.js';

// Build a deterministic high-dimensional vector centered on basis axis `axis`
// with small seeded noise, so we can fabricate well-separated semantic "themes"
// without any randomness leaking between runs.
function themedVector(dim, axis, rng, spread = 0.15) {
	const v = new Array(dim).fill(0);
	for (let i = 0; i < dim; i++) v[i] = (rng() - 0.5) * spread;
	v[axis] += 1;
	return v;
}

function makeBlobs(dims, axes, perBlob) {
	const rng = makeRng(12345);
	const vectors = [];
	const labels = [];
	axes.forEach((axis, blob) => {
		for (let i = 0; i < perBlob; i++) {
			vectors.push(themedVector(dims, axis, rng));
			labels.push(blob);
		}
	});
	return { vectors, labels };
}

describe('vector primitives', () => {
	it('cosineSimilarity: identical=1, orthogonal=0, opposite=-1', () => {
		expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
		expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
	});

	it('cosineSimilarity handles zero vectors without NaN', () => {
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});

	it('unit returns a unit-length vector and leaves zero vectors alone', () => {
		const u = unit([3, 4]);
		expect(Math.hypot(...u)).toBeCloseTo(1, 6);
		expect(unit([0, 0, 0])).toEqual([0, 0, 0]);
	});

	it('meanCenter zeroes every column mean', () => {
		const { centered } = meanCenter([[1, 10], [3, 20], [5, 30]]);
		const colMean = (j) => centered.reduce((s, r) => s + r[j], 0) / centered.length;
		expect(colMean(0)).toBeCloseTo(0, 9);
		expect(colMean(1)).toBeCloseTo(0, 9);
	});
});

describe('projectTo3D', () => {
	it('returns finite 3D points bounded by the radius', () => {
		const { vectors } = makeBlobs(24, [0, 8, 16], 12);
		const coords = projectTo3D(vectors, { radius: 100 });
		expect(coords).toHaveLength(vectors.length);
		for (const c of coords) {
			expect(c).toHaveLength(3);
			for (const v of c) {
				expect(Number.isFinite(v)).toBe(true);
				expect(Math.abs(v)).toBeLessThanOrEqual(100.001);
			}
		}
	});

	it('is deterministic across runs', () => {
		const { vectors } = makeBlobs(24, [0, 8], 10);
		const a = projectTo3D(vectors, { radius: 100 });
		const b = projectTo3D(vectors, { radius: 100 });
		expect(a).toEqual(b);
	});

	it('keeps same-theme agents closer than cross-theme agents', () => {
		const perBlob = 14;
		const { vectors, labels } = makeBlobs(32, [0, 16], perBlob);
		const coords = projectTo3D(vectors, { radius: 100 });
		const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
		let intra = 0, intraN = 0, inter = 0, interN = 0;
		for (let i = 0; i < coords.length; i++) {
			for (let j = i + 1; j < coords.length; j++) {
				const dist = d2(coords[i], coords[j]);
				if (labels[i] === labels[j]) { intra += dist; intraN++; }
				else { inter += dist; interN++; }
			}
		}
		// Same-theme pairs must be markedly tighter than cross-theme pairs.
		expect(intra / intraN).toBeLessThan(inter / interN);
	});

	it('handles degenerate inputs', () => {
		expect(projectTo3D([])).toEqual([]);
		expect(projectTo3D([[1, 2, 3]])).toEqual([[0, 0, 0]]);
	});
});

describe('kmeans', () => {
	it('recovers well-separated blobs', () => {
		const perBlob = 15;
		const { vectors, labels } = makeBlobs(20, [0, 7, 14], perBlob);
		const unitVecs = vectors.map(unit);
		const { assignments, k } = kmeans(unitVecs, 3);
		expect(k).toBe(3);
		// Every true blob must map to a single predicted label (a bijection).
		const mapping = new Map();
		let consistent = true;
		for (let i = 0; i < labels.length; i++) {
			const truth = labels[i];
			if (!mapping.has(truth)) mapping.set(truth, assignments[i]);
			else if (mapping.get(truth) !== assignments[i]) consistent = false;
		}
		expect(consistent).toBe(true);
		expect(new Set(mapping.values()).size).toBe(3); // distinct clusters
	});

	it('is deterministic', () => {
		const { vectors } = makeBlobs(16, [0, 8], 10);
		const u = vectors.map(unit);
		expect(kmeans(u, 2).assignments).toEqual(kmeans(u, 2).assignments);
	});

	it('never returns empty clusters when n >= k', () => {
		const { vectors } = makeBlobs(12, [0, 4, 8], 6);
		const u = vectors.map(unit);
		const { assignments, k } = kmeans(u, 3);
		const counts = new Array(k).fill(0);
		for (const a of assignments) counts[a]++;
		for (const c of counts) expect(c).toBeGreaterThan(0);
	});

	it('clamps k to n', () => {
		const { vectors } = makeBlobs(8, [0, 4], 1); // only 2 vectors
		expect(kmeans(vectors.map(unit), 5).k).toBe(2);
	});
});

describe('suggestClusterCount', () => {
	it('stays within sane bounds', () => {
		expect(suggestClusterCount(0)).toBe(1);
		expect(suggestClusterCount(3)).toBe(1);
		expect(suggestClusterCount(16)).toBe(2);
		expect(suggestClusterCount(1000)).toBe(8);
		for (let n = 0; n < 2000; n += 17) {
			const k = suggestClusterCount(n);
			expect(k).toBeGreaterThanOrEqual(1);
			expect(k).toBeLessThanOrEqual(8);
		}
	});
});

describe('semantic search ranking (cosine)', () => {
	it('ranks the matching theme above unrelated themes', () => {
		const dims = 24;
		const { vectors, labels } = makeBlobs(dims, [0, 8, 16], 8);
		// A query aligned with theme 1 (axis 8) should rank theme-1 vectors top.
		const rng = makeRng(99);
		const query = themedVector(dims, 8, rng);
		const ranked = vectors
			.map((v, i) => ({ label: labels[i], score: cosineSimilarity(query, v) }))
			.sort((a, b) => b.score - a.score);
		// The top several results should all belong to theme 1.
		expect(ranked.slice(0, 5).every((r) => r.label === 1)).toBe(true);
	});
});
