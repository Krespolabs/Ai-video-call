// agora-citizens — the Fetcher profession (capability bit 0).
//
// Real, verifiable work: a Fetcher calls a live HTTP / x402 service, captures the
// EXACT response bytes, stores an immutable content-addressed snapshot, and binds
// the proof to those stored bytes —
//
//     proofHash = sha256(the exact bytes served at deliverableUrl)
//
// the same invariant every profession (work/_skills.js) and the UI verifier
// (src/agora/verify.js) rely on: re-download the deliverable, sha256 it, reproduce
// the on-chain proof. The live target is VOLATILE (the bazaar moves between
// ticks), so the deliverable never points at it — that would make an honest
// re-hash look like a tamper. We snapshot the bytes instead.
//
// No fake data, no setTimeout progress — every byte comes from a real fetch.

import { buildWorkResult, storeDeliverable } from './_skills.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CAPTURE_BYTES = 256 * 1024; // bound memory — snapshot, don't hoard

async function fetchWithTimeout(url, opts = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

// Default work target: the live three.ws AgenC ↔ x402 bridge. A deterministic,
// always-available real resource — the same target the proven roundtrip uses.
export function defaultTarget(cfg) {
	return `${cfg.apiBase}/api/agenc/x402-services?maxItems=5`;
}

/**
 * Perform a Fetcher job and produce a re-derivable proof bound to an immutable
 * snapshot of the fetched bytes.
 *
 * @param {object} opts
 * @param {object} opts.cfg      runtime config (apiBase, etc.)
 * @param {object} opts.citizen  { agentIdHex, displayName, pubkey }
 * @param {object} [opts.job]    optional board job: { source, resource, taskPda }
 * @returns {{ result, resultText, proofHashHex, proofHashBytes, resultData,
 *            deliverableUrl, bytes, target, status, paymentRequired, fingerprint }}
 */
export async function runFetcher({ cfg, citizen, job } = {}) {
	// Pick a target. A board x402 service brings its own resource URL; an AgenC
	// task (or no job) falls back to the canonical bridge target.
	let target = defaultTarget(cfg);
	if (job?.resource && /^https?:\/\//i.test(job.resource)) target = job.resource;

	let res;
	try {
		res = await fetchWithTimeout(target, { headers: { accept: 'application/json, */*' } });
	} catch (err) {
		// A bad target must never abort the loop — fall back to the canonical bridge
		// so the citizen still produces real, verifiable work this tick.
		if (target !== defaultTarget(cfg)) {
			target = defaultTarget(cfg);
			res = await fetchWithTimeout(target, { headers: { accept: 'application/json, */*' } });
		} else {
			throw err;
		}
	}

	const status = res.status;
	const contentType = (res.headers.get('content-type') || '').toLowerCase();
	const paymentRequired = status === 402;

	// Capture the EXACT response bytes (bounded). A 402 challenge from a paid x402
	// service is itself a real, hashable response — recorded honestly rather than
	// fabricating a paid result. Real x402 settlement is a mainnet money flow, out
	// of devnet scope; the citizen's verifiable artifact is the real fetch.
	const ab = await res.arrayBuffer();
	let bytes = Buffer.from(ab);
	if (bytes.length > MAX_CAPTURE_BYTES) bytes = bytes.subarray(0, MAX_CAPTURE_BYTES);

	const ext = contentType.includes('application/json')
		? 'json'
		: contentType.includes('text/') || contentType.includes('xml') || contentType.includes('csv')
			? 'txt'
			: 'bin';

	// Immutable content-addressed snapshot. optional:true with NO volatile sourceUrl
	// degrades to url:null when R2 is unconfigured (the proof still binds the exact
	// bytes; it just isn't re-downloadable in that environment) — it never falls
	// back to the live URL, which would re-introduce a false "tampered" verdict.
	const stored = await storeDeliverable({
		profession: 'fetcher',
		ext,
		contentType: contentType || 'application/octet-stream',
		bytes,
		optional: true,
	});

	const out = buildWorkResult({
		profession: 'fetcher',
		citizen,
		deliverableUrl: stored.url,
		deliverableBytes: bytes,
		summary: `Fetched ${bytes.length} B from ${target} (HTTP ${status})`,
		meta: {
			target,
			status,
			contentType: contentType || null,
			paymentRequired,
			taskPda: job?.taskPda || null,
			storedToR2: stored.stored,
		},
	});

	// Back-compat extras the engine narration references. The proof now IS the
	// fingerprint of the exact stored bytes.
	out.target = target;
	out.status = status;
	out.paymentRequired = paymentRequired;
	out.fingerprint = out.proofHashHex;
	return out;
}
