// Agent Galaxy assembly — turns a set of agents and their IBM Granite embedding
// vectors into the constellation payload the 3D viewer renders.
//
// The heavy linear algebra lives in embedding-math.js (PCA projection, k-means);
// this module is the orchestration on top of it: align agents to vectors, project
// to 3D, cluster into constellations, hand the clusters to a caller-supplied namer
// (Granite, in production) and shape a compact client payload that never ships the
// high-dimensional vectors themselves.
//
// assembleGalaxy() takes the cluster namer as an injected async function so the
// pure projection/clustering path can be exercised deterministically offline
// (see scripts/verify-galaxy.mjs) without a watsonx round-trip. There is no mock
// path in production: real coordinates come from real Granite vectors, and when
// naming is unavailable each constellation falls back to a label derived from its
// own members' words — never invented data.

import {
	projectTo3D,
	kmeans,
	suggestClusterCount,
	unit,
	cosineSimilarity,
} from './embedding-math.js';

// A fixed, legible constellation palette. Cool IBM-cohesive tones lead (the galaxy
// lives next to the IBM partner page) with a few warm accents so adjacent clusters
// stay distinguishable. Indexed by cluster id, wrapping if k exceeds the palette.
export const CLUSTER_COLORS = [
	'#78a9ff', // ibm light blue
	'#33b1ff',
	'#08bdba', // teal
	'#a56eff', // violet
	'#ff7eb6', // magenta
	'#42be65', // green
	'#ffb000', // amber
	'#fa4d56', // red
];

// Layout radius of the constellation cube, in world units. Fixed so successive
// rebuilds (with the same agents) land in the same volume — the viewer's camera
// framing assumes this scale.
const RADIUS = 120;

// Round a coordinate to a compact precision. The viewer doesn't need full float64
// and it keeps the JSON snapshot small for galaxies with hundreds of agents.
function round(n) {
	return Math.round(n * 100) / 100;
}

// English stopwords + platform-generic terms we never want surfacing as a
// constellation's defining word. Keeps fallback labels meaningful.
const STOP = new Set(
	(
		'the a an and or of to for with in on at by from is are be your you our we ' +
		'that this it its as into your their his her can will more most your agent ' +
		'agents ai assistant helps help bot powered using use uses build builds make ' +
		'makes create creates get gets your one all any new your '
	)
		.split(/\s+/)
		.filter(Boolean),
);

// Derive a 1–2 word label for a constellation from the words its members use most.
// Deterministic and grounded in real agent text — the safety net when the LLM namer
// is unavailable or returns nothing usable.
function fallbackLabel(members) {
	const freq = new Map();
	for (const m of members) {
		const text = `${m.name || ''} ${m.description || ''}`.toLowerCase();
		for (const w of text.match(/[a-z][a-z0-9'-]{2,}/g) || []) {
			if (STOP.has(w)) continue;
			freq.set(w, (freq.get(w) || 0) + 1);
		}
	}
	const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w);
	if (!top.length) return 'Uncharted';
	return top.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Build the prompt that asks an LLM (Granite) to name one constellation from a
// sample of its members. Exported so the endpoint and any future namer share the
// exact wording, and so the contract is testable.
export function clusterNamePrompt(members, { sample = 12 } = {}) {
	const lines = members
		.slice(0, sample)
		.map((m) => {
			const desc = (m.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
			return `- ${m.name}${desc ? ` — ${desc}` : ''}`;
		})
		.join('\n');
	return (
		'You are naming a constellation in a star-map of AI agents that were grouped ' +
		'together because they are semantically similar. Below are some of the agents ' +
		'in this group.\n\n' +
		`${lines}\n\n` +
		'Reply with ONLY a compact JSON object, no prose, no code fence:\n' +
		'{"name": "<an evocative 2-4 word constellation name that captures the shared theme>", ' +
		'"theme": "<one short sentence describing what these agents have in common>"}'
	);
}

// Parse a namer's reply into { name, theme }. Tolerant of code fences and stray
// prose around the JSON; returns {} when nothing usable is found so the caller
// falls back to a member-derived label.
export function parseClusterName(text) {
	if (!text) return {};
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) return {};
	try {
		const obj = JSON.parse(match[0]);
		return {
			name: typeof obj.name === 'string' ? obj.name.trim().slice(0, 40) : '',
			theme: typeof obj.theme === 'string' ? obj.theme.trim().slice(0, 160) : '',
		};
	} catch {
		return {};
	}
}

// Assemble the galaxy payload.
//
//   agents   — array of display records ({ id, name, description, thumbnail, … }).
//   vectors  — Granite vectors aligned 1:1 with `agents`; null where un-embeddable.
//   opts.nameClusters(clusters) — async, returns [{ name, theme }] aligned to the
//                 clusters array. Optional; omitted → member-derived fallback names.
//
// Returns { count, dims, model, clusters, agents } with no raw vectors. Agents that
// lack a vector are dropped (the caller already logged how many).
export async function assembleGalaxy(agents, vectors, { dims, model, nameClusters } = {}) {
	const items = [];
	for (let i = 0; i < agents.length; i++) {
		const v = vectors[i];
		if (Array.isArray(v) && v.length) items.push({ agent: agents[i], vec: v });
	}
	const n = items.length;
	if (n === 0) return { count: 0, dims: dims || 0, model: model || null, clusters: [], agents: [] };

	const rawVectors = items.map((it) => it.vec);
	const realDims = rawVectors[0].length;

	// 3D layout from the top principal components (deterministic, seeded).
	const coords = projectTo3D(rawVectors, { radius: RADIUS });

	// Cluster on L2-normalised vectors so squared-euclidean ranks like cosine —
	// constellations are then semantic, matching how search ranks below.
	const unitVectors = rawVectors.map(unit);
	const { assignments, k: realK } = kmeans(unitVectors, suggestClusterCount(n));

	// Aggregate members per cluster and compute each constellation's 3D centroid
	// (mean of member coordinates) so the viewer can place a floating label and the
	// legend can fly the camera there.
	const clusters = [];
	for (let c = 0; c < realK; c++) {
		const memberIdx = [];
		for (let i = 0; i < n; i++) if (assignments[i] === c) memberIdx.push(i);
		const centroid = [0, 0, 0];
		for (const i of memberIdx) {
			centroid[0] += coords[i][0];
			centroid[1] += coords[i][1];
			centroid[2] += coords[i][2];
		}
		const m = memberIdx.length || 1;
		const members = memberIdx.map((i) => ({
			name: items[i].agent.name,
			description: items[i].agent.description,
		}));
		clusters.push({
			id: c,
			color: CLUSTER_COLORS[c % CLUSTER_COLORS.length],
			size: memberIdx.length,
			centroid: [round(centroid[0] / m), round(centroid[1] / m), round(centroid[2] / m)],
			_members: members,
		});
	}

	// Name the constellations. The namer sees each cluster's members; we keep its
	// reply aligned by index and fall back to a member-derived label on any miss.
	let named = [];
	if (nameClusters) {
		try {
			named = (await nameClusters(clusters.map((c) => ({ id: c.id, members: c._members })))) || [];
		} catch {
			named = [];
		}
	}
	for (let c = 0; c < clusters.length; c++) {
		const got = named[c] || {};
		clusters[c].label = (got.name || '').trim() || fallbackLabel(clusters[c]._members);
		clusters[c].theme = (got.theme || '').trim();
		delete clusters[c]._members;
	}

	const outAgents = items.map((it, i) => ({
		id: it.agent.id,
		name: it.agent.name,
		description: it.agent.description || '',
		thumbnail: it.agent.thumbnail || null,
		wallet: it.agent.wallet || null,
		chain: it.agent.chain || null,
		chat_count: it.agent.chat_count || 0,
		token: it.agent.token || null,
		cluster: assignments[i],
		coords: [round(coords[i][0]), round(coords[i][1]), round(coords[i][2])],
	}));

	return { count: n, dims: realDims, model: model || null, clusters, agents: outAgents };
}

// Rank agents by cosine similarity of their Granite vector against a query vector.
//   queryVec      — the embedded search query.
//   vectorsById   — Map agentId → vector (from readAgentVectors()).
// Returns [{ id, score }] sorted high→low, length ≤ `topK`, scores in [-1, 1].
export function rankBySimilarity(queryVec, vectorsById, { topK = 12, minScore = 0.05 } = {}) {
	const scored = [];
	for (const [id, vec] of vectorsById) {
		if (!Array.isArray(vec) || !vec.length) continue;
		const score = cosineSimilarity(queryVec, vec);
		if (score >= minScore) scored.push({ id, score: Math.round(score * 1000) / 1000 });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topK);
}
