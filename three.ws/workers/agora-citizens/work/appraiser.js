// Appraiser (capability bit 5) — token / market intel. Backed by @three-ws/intel
// over the public /api/social/sentiment-pulse endpoint. Produces a stable
// appraisal snapshot (sentiment + breakdown + sources) and proves it with sha256.
// Same `run<Profession>` contract as work/fetcher.js.
//
// $THREE is the coin this platform denominates in and the default appraisal
// subject. A task may supply an arbitrary mint at runtime (generic, runtime-
// supplied plumbing) — but no other coin is ever hardcoded, named, or promoted.

import { buildWorkResult, storeDeliverable, httpJson, canonicalJsonBytes } from './_skills.js';

// The only coin this platform references. Default appraisal subject.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

export async function runAppraiser({ cfg, citizen, job } = {}) {
	const apiBase = cfg?.apiBase || 'https://three.ws';
	const log = cfg?.log || (() => {});
	const mint = String(job?.mint || THREE_MINT).trim();

	log?.(`appraiser: sentiment pulse for ${mint}`);
	// The endpoint keys the subject as `token` (the base58 mint pubkey) and returns
	// { ok, token, overall, breakdown, sources } with no `data` wrapper.
	const res = await httpJson(apiBase, '/api/social/sentiment-pulse', { method: 'POST', body: { token: mint, limit: 100 } });
	const data = res?.data || res || {};

	const appraisal = {
		kind: 'agora.appraisal.v1',
		mint,
		overall: data.overall ?? null,
		breakdown: data.breakdown ?? null,
		sources: data.sources ?? null,
	};
	if (appraisal.overall == null && appraisal.breakdown == null) {
		throw new Error('appraiser: sentiment endpoint returned no signal');
	}

	const bytes = canonicalJsonBytes(appraisal);
	const deliverable = await storeDeliverable({
		profession: 'appraiser',
		ext: 'json',
		contentType: 'application/json',
		bytes,
		optional: true,
	});

	const score = typeof appraisal.overall === 'object' ? JSON.stringify(appraisal.overall) : String(appraisal.overall);
	return buildWorkResult({
		profession: 'appraiser',
		citizen,
		deliverableUrl: deliverable.url,
		deliverableBytes: bytes,
		summary: `Appraised ${mint === THREE_MINT ? '$THREE' : mint}: sentiment ${score}`,
		meta: { mint, stored: deliverable.stored },
	});
}

export default runAppraiser;
