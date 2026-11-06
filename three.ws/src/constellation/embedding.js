// Pure embedding-space math for the watsonx Constellation — no three.js, no DOM,
// so it can be unit-tested in Node and reused anywhere. Everything here operates
// on plain number arrays (the IBM Granite embedding vectors).

// The text we embed for a token: its name + ticker. Sliced to a sane length so
// one outlier name can't dominate the request body (the endpoint caps too).
export function tokenText(token) {
	return `${token.name} (${token.symbol})`.slice(0, 256);
}

// PCA → 3 dimensions via classical MDS (eigendecomposition of the N×N Gram
// matrix). For N tokens of dimension D with N << D this is far cheaper and more
// numerically stable than eigendecomposing the D×D covariance: the principal
// coordinates are the top eigenvectors of G = XXᵀ scaled by √eigenvalue.
//
// Returns an array of [x, y, z] triples aligned with the input order.
export function pca3(vectors) {
	const n = vectors.length;
	if (n === 0) return [];
	const d = vectors[0].length;

	// Mean-center the rows.
	const mean = new Float64Array(d);
	for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j];
	for (let j = 0; j < d; j++) mean[j] /= n;
	const X = vectors.map((v) => {
		const r = new Float64Array(d);
		for (let j = 0; j < d; j++) r[j] = v[j] - mean[j];
		return r;
	});

	// Gram matrix G = X Xᵀ (symmetric, N×N).
	const M = Array.from({ length: n }, () => new Float64Array(n));
	for (let i = 0; i < n; i++) {
		for (let k = i; k < n; k++) {
			let s = 0;
			const xi = X[i], xk = X[k];
			for (let j = 0; j < d; j++) s += xi[j] * xk[j];
			M[i][k] = s; M[k][i] = s;
		}
	}

	const coords = Array.from({ length: n }, () => [0, 0, 0]);
	const matVec = (A, v) => {
		const w = new Float64Array(n);
		for (let i = 0; i < n; i++) { let s = 0; const row = A[i]; for (let k = 0; k < n; k++) s += row[k] * v[k]; w[i] = s; }
		return w;
	};
	const norm = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); };

	const axes = Math.min(3, n);
	for (let c = 0; c < axes; c++) {
		// Deterministic, non-degenerate seed so the layout is stable across loads.
		let v = new Float64Array(n);
		for (let i = 0; i < n; i++) v[i] = Math.sin(i * (c + 1) * 0.7 + 1) + 0.13;
		let nv = norm(v); for (let i = 0; i < n; i++) v[i] /= nv;
		let lambda = 0;
		for (let it = 0; it < 256; it++) {
			const w = matVec(M, v);
			const wn = norm(w);
			if (wn < 1e-12) break;
			for (let i = 0; i < n; i++) w[i] /= wn;
			let dot = 0; for (let i = 0; i < n; i++) dot += w[i] * v[i];
			lambda = wn; v = w;
			if (Math.abs(Math.abs(dot) - 1) < 1e-9) break;
		}
		const scale = Math.sqrt(Math.max(lambda, 0));
		for (let i = 0; i < n; i++) coords[i][c] = v[i] * scale;
		// Deflate so the next iteration recovers the next principal axis.
		for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) M[i][k] -= lambda * v[i] * v[k];
	}
	return coords;
}

// Rescale raw PCA coordinates so the largest absolute component maps to `radius`.
export function normalizeCoordsToRadius(coords, radius) {
	let max = 1e-9;
	for (const c of coords) for (const x of c) max = Math.max(max, Math.abs(x));
	const k = radius / max;
	return coords.map((c) => [c[0] * k, c[1] * k, c[2] * k]);
}

// Cosine-similarity nearest neighbors of vectors[idx]. Returns the top-k other
// indices by similarity, descending. Vectors that are missing/empty are skipped.
export function cosineNeighbors(vectors, idx, k = 3) {
	const a = vectors[idx];
	if (!a || !a.length) return [];
	const dot = (x, y) => { let s = 0; for (let j = 0; j < x.length; j++) s += x[j] * y[j]; return s; };
	const na = Math.sqrt(dot(a, a)) || 1;
	const sims = [];
	for (let j = 0; j < vectors.length; j++) {
		if (j === idx || !vectors[j] || !vectors[j].length) continue;
		const b = vectors[j];
		const nb = Math.sqrt(dot(b, b)) || 1;
		sims.push({ index: j, sim: dot(a, b) / (na * nb) });
	}
	sims.sort((x, y) => y.sim - x.sim);
	return sims.slice(0, k);
}
