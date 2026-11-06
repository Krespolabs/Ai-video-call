// embedding-math — deterministic, dependency-free linear algebra for projecting
// high-dimensional IBM Granite embedding vectors into a 3D constellation and
// grouping them into semantic clusters.
//
// Everything here is pure and deterministic: given the same input vectors it
// always returns the same projection and the same cluster assignments. That
// matters because the Agent Galaxy is rebuilt server-side and cached — two
// rebuilds of the same agent set must produce a stable layout, not a layout
// that jumps every refresh. Determinism comes from a seeded PRNG (no
// Math.random) and fixed iteration counts.
//
// No external math library: the operations we need (mean-centering, implicit
// power iteration for the top principal components, Lloyd's algorithm with a
// k-means++ seeding) are small and run comfortably in a serverless function for
// a few hundred ~768-dim vectors.

// ── Seeded PRNG ──────────────────────────────────────────────────────────────
// mulberry32: a tiny, fast, well-distributed 32-bit generator. Seeding it makes
// k-means++ selection and the power-iteration start vectors reproducible.
export function makeRng(seed = 0x9e3779b9) {
	let a = seed >>> 0;
	return function next() {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── Vector primitives ────────────────────────────────────────────────────────

export function dot(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

export function norm(a) {
	return Math.sqrt(dot(a, a));
}

// L2-normalise a vector to unit length. Returns a copy; a zero vector is
// returned unchanged (no divide-by-zero).
export function unit(a) {
	const n = norm(a);
	if (n === 0) return a.slice();
	const out = new Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i] / n;
	return out;
}

// Cosine similarity in [-1, 1]. Used for semantic search ranking: a query
// embedding vs every agent embedding.
export function cosineSimilarity(a, b) {
	const na = norm(a);
	const nb = norm(b);
	if (na === 0 || nb === 0) return 0;
	return dot(a, b) / (na * nb);
}

// ── Mean centering ───────────────────────────────────────────────────────────
// Subtract the column mean from every row. PCA operates on centered data; the
// mean vector is returned so callers can project new points into the same space.
export function meanCenter(vectors) {
	const n = vectors.length;
	const d = vectors[0].length;
	const mean = new Array(d).fill(0);
	for (const v of vectors) {
		for (let j = 0; j < d; j++) mean[j] += v[j];
	}
	for (let j = 0; j < d; j++) mean[j] /= n;
	const centered = vectors.map((v) => {
		const out = new Array(d);
		for (let j = 0; j < d; j++) out[j] = v[j] - mean[j];
		return out;
	});
	return { centered, mean };
}

// ── PCA via implicit power iteration ─────────────────────────────────────────
// Find the top-`k` principal directions of a centered NxD matrix without ever
// materialising the DxD covariance matrix. Each power-iteration step is the
// implicit product Cv = Xᵀ(Xv), which costs O(N·D) instead of O(D²). After a
// component converges we deflate it out of X (remove its rank-1 contribution)
// so the next iteration finds the next-largest direction. Components come back
// orthonormal, largest variance first.
function topComponents(centered, k, { iterations = 64, seed = 1 } = {}) {
	const n = centered.length;
	const d = centered[0].length;
	// Work on a mutable copy we can deflate in place.
	const X = centered.map((row) => row.slice());
	const rng = makeRng(seed);
	const components = [];

	for (let c = 0; c < k; c++) {
		// Deterministic, non-degenerate start vector.
		let v = new Array(d);
		for (let j = 0; j < d; j++) v[j] = rng() * 2 - 1;
		v = unit(v);

		for (let it = 0; it < iterations; it++) {
			// p = X v   (length N)
			const p = new Array(n);
			for (let i = 0; i < n; i++) p[i] = dot(X[i], v);
			// w = Xᵀ p  (length D)  →  w ∝ C v
			const w = new Array(d).fill(0);
			for (let i = 0; i < n; i++) {
				const pi = p[i];
				const row = X[i];
				for (let j = 0; j < d; j++) w[j] += row[j] * pi;
			}
			const wn = norm(w);
			if (wn === 0) break; // exhausted variance — remaining comps are zero
			for (let j = 0; j < d; j++) w[j] /= wn;
			v = w;
		}

		components.push(v);

		// Deflate: X ← X − (X v) vᵀ, stripping this component's variance so the
		// next pass surfaces the following principal direction.
		for (let i = 0; i < n; i++) {
			const pi = dot(X[i], v);
			const row = X[i];
			for (let j = 0; j < d; j++) row[j] -= pi * v[j];
		}
	}
	return components;
}

// Project N D-dimensional vectors down to N 3-dimensional points laid out by
// their three largest principal components, then whiten each axis (z-score) and
// scale to a cube of half-width `radius`. Whitening is a deliberate
// visualisation choice: raw PC variances fall off fast (PC1 ≫ PC3), which would
// squash the cloud into a flat disk; standardising each axis gives a balanced,
// fly-through-able 3D volume while preserving each axis's relative ordering.
//
// Degenerate inputs are handled honestly: 0 vectors → [], and a single vector
// (or fewer than 3 usable dimensions) still returns finite, centered points.
export function projectTo3D(vectors, { radius = 100, seed = 1 } = {}) {
	const n = vectors.length;
	if (n === 0) return [];
	if (n === 1) return [[0, 0, 0]];

	const { centered } = meanCenter(vectors);
	const comps = topComponents(centered, 3, { seed });

	// Score every point against each component. Missing components (when the
	// data has fewer than 3 non-zero principal directions) contribute 0.
	const coords = centered.map((row) => {
		const c = [0, 0, 0];
		for (let k = 0; k < comps.length; k++) c[k] = dot(row, comps[k]);
		return c;
	});

	// Per-axis whitening → uniform scale to the target radius.
	for (let axis = 0; axis < 3; axis++) {
		let mean = 0;
		for (const c of coords) mean += c[axis];
		mean /= n;
		let varr = 0;
		for (const c of coords) varr += (c[axis] - mean) ** 2;
		const std = Math.sqrt(varr / n) || 1;
		for (const c of coords) c[axis] = (c[axis] - mean) / std;
	}

	// After whitening each axis is unit-variance; clamp the rare outlier and map
	// to [-radius, radius] using a fixed spread (≈99.7% of mass within ±3σ).
	const SPREAD = 3;
	for (const c of coords) {
		for (let axis = 0; axis < 3; axis++) {
			const clamped = Math.max(-SPREAD, Math.min(SPREAD, c[axis]));
			c[axis] = (clamped / SPREAD) * radius;
		}
	}
	return coords;
}

// ── k-means (Lloyd's algorithm, k-means++ seeding) ──────────────────────────
// Cluster vectors into `k` groups. Vectors are expected L2-normalised by the
// caller so squared-euclidean distance ranks the same as cosine distance —
// i.e. clusters are semantic. Seeding is deterministic (seeded k-means++), and
// empty clusters are re-seeded to the farthest point so `k` groups always come
// back non-empty when n ≥ k.
function sqDist(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		const diff = a[i] - b[i];
		s += diff * diff;
	}
	return s;
}

export function kmeans(vectors, k, { maxIter = 50, seed = 7 } = {}) {
	const n = vectors.length;
	if (n === 0) return { assignments: [], centroids: [], k: 0 };
	const realK = Math.max(1, Math.min(k, n));
	const d = vectors[0].length;
	const rng = makeRng(seed);

	// k-means++ seeding: first centroid random, each subsequent centroid chosen
	// with probability proportional to its squared distance from the nearest
	// already-chosen centroid. Spreads seeds out → faster, better convergence.
	const centroids = [];
	centroids.push(vectors[Math.floor(rng() * n)].slice());
	while (centroids.length < realK) {
		const d2 = new Array(n);
		let total = 0;
		for (let i = 0; i < n; i++) {
			let best = Infinity;
			for (const c of centroids) {
				const dist = sqDist(vectors[i], c);
				if (dist < best) best = dist;
			}
			d2[i] = best;
			total += best;
		}
		let target = rng() * total;
		let idx = 0;
		for (; idx < n; idx++) {
			target -= d2[idx];
			if (target <= 0) break;
		}
		centroids.push(vectors[Math.min(idx, n - 1)].slice());
	}

	const assignments = new Array(n).fill(0);
	for (let iter = 0; iter < maxIter; iter++) {
		let moved = false;
		// Assign each point to its nearest centroid.
		for (let i = 0; i < n; i++) {
			let best = 0;
			let bestDist = Infinity;
			for (let c = 0; c < realK; c++) {
				const dist = sqDist(vectors[i], centroids[c]);
				if (dist < bestDist) {
					bestDist = dist;
					best = c;
				}
			}
			if (assignments[i] !== best) {
				assignments[i] = best;
				moved = true;
			}
		}

		// Recompute centroids as the mean of their members.
		const sums = Array.from({ length: realK }, () => new Array(d).fill(0));
		const counts = new Array(realK).fill(0);
		for (let i = 0; i < n; i++) {
			const a = assignments[i];
			counts[a]++;
			const row = vectors[i];
			const s = sums[a];
			for (let j = 0; j < d; j++) s[j] += row[j];
		}
		for (let c = 0; c < realK; c++) {
			if (counts[c] === 0) {
				// Re-seed an empty cluster to the point farthest from any centroid
				// so we never collapse below k clusters.
				let far = 0;
				let farDist = -1;
				for (let i = 0; i < n; i++) {
					let nearest = Infinity;
					for (let cc = 0; cc < realK; cc++) {
						const dist = sqDist(vectors[i], centroids[cc]);
						if (dist < nearest) nearest = dist;
					}
					if (nearest > farDist) {
						farDist = nearest;
						far = i;
					}
				}
				centroids[c] = vectors[far].slice();
				moved = true;
			} else {
				const s = sums[c];
				for (let j = 0; j < d; j++) centroids[c][j] = s[j] / counts[c];
			}
		}

		if (!moved) break;
	}

	return { assignments, centroids, k: realK };
}

// Choose a sensible cluster count for n agents: roughly one theme per eight
// agents, bounded to [2, 8] so the legend stays legible and small galaxies
// don't over-fragment. Below 4 agents there's nothing meaningful to split.
export function suggestClusterCount(n) {
	if (n < 4) return 1;
	return Math.max(2, Math.min(8, Math.round(n / 8)));
}
