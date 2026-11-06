// verify-watsonx — end-to-end check for the watsonx Constellation pipeline.
//
//   node scripts/verify-watsonx.mjs
//
// Always runs the PCA self-test (pure math, no network). When WATSONX_API_KEY +
// WATSONX_PROJECT_ID (or WATSONX_SPACE_ID) are present in the environment it also
// makes REAL calls to IBM watsonx.ai — Granite embeddings and a Granite chat
// completion — and verifies the semantic layout actually separates themes.
//
// Exit code is non-zero only if something that DID run fails; a missing
// credential is reported, not treated as a failure (there is no mock fallback).

import { pca3, normalizeCoordsToRadius, cosineNeighbors } from '../src/constellation/embedding.js';
import { watsonxConfig, watsonxEmbed, watsonxChatComplete } from '../api/_lib/watsonx.js';

let failures = 0;
const ok = (label) => console.log(`  \x1b[32m✓\x1b[0m ${label}`);
const bad = (label) => { console.log(`  \x1b[31m✗ ${label}\x1b[0m`); failures++; };

// Small deterministic PRNG so the synthetic test is reproducible.
function mulberry32(a) {
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pcaSelfTest() {
	console.log('\nPCA self-test (synthetic clusters, no network)');
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
	const coords = normalizeCoordsToRadius(pca3(vectors), 28);
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	let within = 0, wn = 0, between = 0, bn = 0;
	for (let i = 0; i < coords.length; i++) {
		for (let j = i + 1; j < coords.length; j++) {
			const d = dist(coords[i], coords[j]);
			if (labels[i] === labels[j]) { within += d; wn++; } else { between += d; bn++; }
		}
	}
	const avgWithin = within / wn;
	const avgBetween = between / bn;
	console.log(`  avg within-cluster distance:  ${avgWithin.toFixed(2)}`);
	console.log(`  avg between-cluster distance: ${avgBetween.toFixed(2)}`);
	if (avgBetween > avgWithin * 2) ok('PCA separates the three clusters (between > 2× within)');
	else bad(`PCA did not separate clusters (between ${avgBetween.toFixed(2)} vs within ${avgWithin.toFixed(2)})`);

	// cosineNeighbors should pick same-cluster members first.
	const nn = cosineNeighbors(vectors, 0, 2).map((n) => labels[n.index]);
	if (nn.every((l) => l === labels[0])) ok('cosineNeighbors returns same-cluster neighbors');
	else bad(`cosineNeighbors crossed clusters: got labels ${JSON.stringify(nn)}`);
}

async function watsonxLiveTest() {
	const cfg = watsonxConfig();
	console.log('\nIBM watsonx.ai live test');
	if (!cfg.configured) {
		console.log('  \x1b[33m• watsonx not configured\x1b[0m — set WATSONX_API_KEY and WATSONX_PROJECT_ID');
		console.log('    (or WATSONX_SPACE_ID) to run the real embeddings + Granite calls.');
		console.log('    Skipping live test; this is not a failure.');
		return;
	}
	console.log(`  region: ${cfg.url}  ·  embed model: ${cfg.embedModel}  ·  chat model: ${cfg.chatModel}`);

	// Themed token-like texts: two energy, two AI, two dog-meme. Same-theme pairs
	// should be each other's nearest neighbors in Granite embedding space.
	const texts = [
		'Strategic Oil Reserve (OIL)', 'Global Gas Holdings (GAS)',
		'Neural Agent Protocol (AGENT)', 'Deep Learning Token (NEURO)',
		'Doge To The Moon (DOGE)', 'Shiba Rocket (SHIB)',
	];
	let res;
	try {
		res = await watsonxEmbed(cfg, { inputs: texts });
	} catch (e) {
		bad(`watsonxEmbed threw: ${e.message}`);
		return;
	}
	if (res.vectors?.length === texts.length && res.dimensions > 0) {
		ok(`embedded ${texts.length} texts → ${res.dimensions}-d Granite vectors`);
	} else {
		bad(`unexpected embed result: ${JSON.stringify({ n: res.vectors?.length, d: res.dimensions })}`);
		return;
	}

	// Each text's nearest neighbor should be its same-theme partner (pairs are
	// adjacent in the array: 0-1, 2-3, 4-5).
	let hits = 0;
	for (let i = 0; i < texts.length; i++) {
		const partner = i % 2 === 0 ? i + 1 : i - 1;
		const top = cosineNeighbors(res.vectors, i, 1)[0];
		if (top && top.index === partner) hits++;
	}
	if (hits >= 5) ok(`semantic neighbors correct for ${hits}/6 texts`);
	else bad(`semantic neighbors only correct for ${hits}/6 — embeddings may be off`);

	// Granite chat completion (the analysis path uses the streaming sibling).
	try {
		const chat = await watsonxChatComplete(cfg, {
			messages: [{ role: 'user', content: 'In one short sentence, what is a Solana meme coin?' }],
			maxTokens: 60,
		});
		if (chat.text?.trim()) ok(`Granite chat replied: "${chat.text.trim().slice(0, 80)}…"`);
		else bad('Granite chat returned empty text');
	} catch (e) {
		bad(`watsonxChatComplete threw: ${e.message}`);
	}
}

pcaSelfTest();
await watsonxLiveTest();

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mAll checks that ran passed.\x1b[0m');
process.exit(failures ? 1 : 0);
