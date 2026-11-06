// Cartographer (capability bit 3) — builds a 3D scene / diorama plan from one
// sentence. Backed by @three-ws/scene over the public /api/diorama composer,
// which decomposes the prompt into a placed set of single-object forge prompts.
// The deliverable is the canonical diorama plan; the proof is sha256 of it.
// Same `run<Profession>` contract as work/fetcher.js.

import { buildWorkResult, storeDeliverable, httpJson, canonicalJsonBytes, jobPrompt } from './_skills.js';

const DEFAULT_BRIEFS = [
	'a lonely lighthouse on a stormy cliff',
	'a cozy campsite in a pine clearing at dusk',
	'a bustling night market stall under paper lanterns',
	'a quiet zen garden with a stone bridge',
];

function briefFor(citizen, job) {
	const explicit = jobPrompt(job);
	if (explicit) return explicit;
	const seed = String(citizen?.agentIdHex || job?.taskPda || '0');
	let h = 0;
	for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return DEFAULT_BRIEFS[h % DEFAULT_BRIEFS.length];
}

export async function runCartographer({ cfg, citizen, job } = {}) {
	const apiBase = cfg?.apiBase || 'https://three.ws';
	const log = cfg?.log || (() => {});
	const prompt = briefFor(citizen, job);

	log?.(`cartographer: composing diorama for "${prompt.slice(0, 80)}"`);
	const res = await httpJson(apiBase, '/api/diorama', { method: 'POST', body: { action: 'compose', prompt } });
	const diorama = res?.diorama || res?.data?.diorama || null;
	if (!diorama || !Array.isArray(diorama.objects) || diorama.objects.length === 0) {
		throw new Error('cartographer: composer returned no diorama plan');
	}

	const bytes = canonicalJsonBytes({ kind: 'agora.diorama.v1', prompt, diorama });
	const deliverable = await storeDeliverable({
		profession: 'cartographer',
		ext: 'json',
		contentType: 'application/json',
		bytes,
		optional: true,
	});

	return buildWorkResult({
		profession: 'cartographer',
		citizen,
		deliverableUrl: deliverable.url,
		deliverableBytes: bytes,
		summary: `Composed "${diorama.title || prompt}" — ${diorama.objects.length} placed objects (${diorama.mood || 'day'})`,
		meta: { prompt, objects: diorama.objects.length, mood: diorama.mood || null, stored: deliverable.stored },
	});
}

export default runCartographer;
