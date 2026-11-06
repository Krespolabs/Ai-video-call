// Unit tests for the watsonx Constellation's embedding-space math
// (src/constellation/embedding.js) — pure functions, no three.js / network.

import { describe, it, expect } from 'vitest';
import {
	tokenText,
	pca3,
	normalizeCoordsToRadius,
	cosineNeighbors,
} from '../src/constellation/embedding.js';

// Deterministic PRNG so the synthetic clusters are reproducible across runs.
function mulberry32(a) {
	return () => {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Three well-separated blobs in 16-d space, 5 points each.
function syntheticClusters() {
	const rng = mulberry32(42);
	const D = 16;
	const centers = [
		Array.from({ length: D }, (_, i) => (i < 5 ? 3 : 0)),
		Array.from({ length: D }, (_, i) => (i >= 5 && i < 10 ? 3 : 0)),
		Array.from({ length: D }, (_, i) => (i >= 10 ? 3 : 0)),
	];
	const vectors = [];
	const labels = [];
	centers.forEach((center, c) => {
		for (let k = 0; k < 5; k++) {
			vectors.push(center.map((x) => x + (rng() - 0.5) * 0.3));
			labels.push(c);
		}
	});
	return { vectors, labels };
}

describe('tokenText', () => {
	it('combines name and ticker', () => {
		expect(tokenText({ name: 'Dogwifhat', symbol: 'WIF' })).toBe('Dogwifhat (WIF)');
	});
	it('caps overly long input', () => {
		const long = tokenText({ name: 'x'.repeat(500), symbol: 'Y' });
		expect(long.length).toBeLessThanOrEqual(256);
	});
});

describe('pca3', () => {
	it('returns one [x,y,z] triple per input', () => {
		const { vectors } = syntheticClusters();
		const coords = pca3(vectors);
		expect(coords).toHaveLength(vectors.length);
		for (const c of coords) expect(c).toHaveLength(3);
	});

	it('separates well-separated clusters (between ≫ within)', () => {
		const { vectors, labels } = syntheticClusters();
		const coords = normalizeCoordsToRadius(pca3(vectors), 28);
		const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		let within = 0, wn = 0, between = 0, bn = 0;
		for (let i = 0; i < coords.length; i++) {
			for (let j = i + 1; j < coords.length; j++) {
				const d = dist(coords[i], coords[j]);
				if (labels[i] === labels[j]) { within += d; wn++; } else { between += d; bn++; }
			}
		}
		expect(between / bn).toBeGreaterThan((within / wn) * 2);
	});

	it('is deterministic across runs', () => {
		const { vectors } = syntheticClusters();
		expect(pca3(vectors)).toEqual(pca3(vectors));
	});

	it('handles the empty case', () => {
		expect(pca3([])).toEqual([]);
	});
});

describe('normalizeCoordsToRadius', () => {
	it('scales the largest component to the target radius', () => {
		const scaled = normalizeCoordsToRadius([[0, 0, 0], [2, 0, 0], [0, -10, 5]], 28);
		let max = 0;
		for (const c of scaled) for (const x of c) max = Math.max(max, Math.abs(x));
		expect(max).toBeCloseTo(28, 5);
	});
});

describe('cosineNeighbors', () => {
	it('returns same-cluster members first', () => {
		const { vectors, labels } = syntheticClusters();
		const neighbors = cosineNeighbors(vectors, 0, 2);
		expect(neighbors).toHaveLength(2);
		for (const n of neighbors) expect(labels[n.index]).toBe(labels[0]);
	});

	it('orders by descending similarity and skips self', () => {
		const { vectors } = syntheticClusters();
		const neighbors = cosineNeighbors(vectors, 3, 4);
		expect(neighbors.every((n) => n.index !== 3)).toBe(true);
		for (let i = 1; i < neighbors.length; i++) {
			expect(neighbors[i - 1].sim).toBeGreaterThanOrEqual(neighbors[i].sim);
		}
	});

	it('returns nothing for a missing vector', () => {
		expect(cosineNeighbors([null, [1, 2, 3]], 0, 3)).toEqual([]);
	});
});
