// Diorama — generation orchestration.
//
// One sentence becomes a tiny explorable 3D world in two acts:
//
//   1. COMPOSE — POST /api/diorama {action:'compose'} asks the platform's
//      free-first LLM chain to decompose the sentence into a placed *plan*:
//      a mood, palette, ground, island shape, and a handful of single-object
//      forge prompts (each object status:'pending', no mesh yet).
//
//   2. FORGE — every object's prompt is turned into a real GLB on the EXISTING
//      free text→3D lane (POST /api/forge {tier:'draft', path:'image'}). Forges
//      run a few at a time so the world materializes progressively, and a failed
//      object never sinks the whole world — partial worlds are real and shareable.
//
// This module owns only the orchestration + the per-browser client identity.
// The shape of a Diorama lives in ./schema.js; the controller (./main.js) drives
// the DOM from the callbacks below.

import { normalizeDiorama, MAX_PROMPT_LEN } from './schema.js';

// ── Per-browser identity ────────────────────────────────────────────────────
// A stable id so forge jobs are scoped per browser (sent as `x-forge-client`).
// Persisted in localStorage; falls back to a fresh UUID, and degrades to an
// in-memory id if storage is unavailable (private mode) so forging still works.
export const CLIENT_ID = resolveClientId();

function resolveClientId() {
	const KEY = 'dio_client';
	const fresh = () =>
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `dio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	try {
		const existing = localStorage.getItem(KEY);
		if (existing) return existing;
		const id = fresh();
		localStorage.setItem(KEY, id);
		return id;
	} catch {
		return fresh();
	}
}

// ── Tuning ──────────────────────────────────────────────────────────────────
const FORGE_CONCURRENCY = 3; // objects forged at once on the free lane
const POLL_INTERVAL_MS = 2500; // how often a queued forge job is polled
const FORGE_DEADLINE_MS = 180_000; // 3 min per object before we mark it failed
const FORGE_ENDPOINT = '/api/forge';

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const t = setTimeout(() => {
			signal?.removeEventListener?.('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(abortError());
		};
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});

function abortError() {
	const e = new Error('Cancelled.');
	e.name = 'AbortError';
	e.code = 'aborted';
	return e;
}

const forgeHeaders = () => ({ 'content-type': 'application/json', 'x-forge-client': CLIENT_ID });

/**
 * Compose a world from a sentence, then forge every object into a real mesh.
 *
 * @param {string} prompt                       the user's sentence
 * @param {Object} [opts]
 * @param {(diorama:import('./schema.js').Diorama)=>void} [opts.onPlan]
 *        called once the plan returns, before any mesh exists, so the UI can
 *        render the island + seeds + object chips immediately.
 * @param {(objectId:string, patch:{status:string, glbUrl?:string})=>void} [opts.onObject]
 *        called as each object moves through forging → ready | failed.
 * @param {AbortSignal} [opts.signal]           abort the compose + all forges.
 * @returns {Promise<import('./schema.js').Diorama>} the final, populated diorama.
 */
export async function composeWorld(prompt, { onPlan, onObject, signal } = {}) {
	const sentence = String(prompt ?? '')
		.slice(0, MAX_PROMPT_LEN)
		.trim();
	if (!sentence) {
		const e = new Error('Describe your world in a sentence.');
		e.code = 'prompt_required';
		throw e;
	}

	// ── 1. Compose the plan ──────────────────────────────────────────────────
	let payload;
	try {
		const res = await fetch('/api/diorama', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'compose', prompt: sentence }),
			signal,
		});
		payload = await res.json().catch(() => ({}));
		if (!res.ok) {
			const e = new Error(payload?.message || `The composer returned ${res.status}.`);
			e.code = payload?.error || 'compose_failed';
			throw e;
		}
	} catch (err) {
		if (err?.name === 'AbortError') throw err;
		if (err instanceof TypeError) {
			// Network boundary: fetch itself failed (offline, DNS, CORS).
			const e = new Error('Could not reach the world composer. Check your connection and try again.');
			e.code = 'network';
			throw e;
		}
		throw err;
	}

	// Normalize the untrusted plan into a guaranteed-renderable diorama.
	const { ok, diorama, errors } = normalizeDiorama(payload?.diorama);
	if (!ok || !diorama.objects.length) {
		const e = new Error('The composer could not place that world. Try a more concrete sentence.');
		e.code = 'compose_invalid';
		e.detail = errors;
		throw e;
	}
	// Plan objects start clean: pending, no mesh.
	for (const o of diorama.objects) {
		o.status = 'pending';
		o.glbUrl = null;
	}

	onPlan?.(diorama);

	// ── 2. Forge every object with bounded concurrency ───────────────────────
	const queue = diorama.objects.slice();
	const byId = new Map(diorama.objects.map((o) => [o.id, o]));

	async function worker() {
		for (;;) {
			if (signal?.aborted) throw abortError();
			const object = queue.shift();
			if (!object) return;
			const result = await forgeObject(object, { signal, onObject });
			const live = byId.get(object.id);
			if (live) {
				live.status = result.status;
				live.glbUrl = result.glbUrl ?? null;
			}
		}
	}

	const workers = Array.from({ length: Math.min(FORGE_CONCURRENCY, queue.length) }, worker);
	await Promise.all(workers);

	return diorama;
}

/**
 * Forge a single object's mesh on the free text→3D lane. Resolves with
 * `{ status:'ready', glbUrl }` on success or `{ status:'failed' }` on any
 * failure/timeout — it never throws for a forge failure (a partial world is
 * fine). It DOES propagate an AbortError so the controller can stop cleanly.
 *
 * Exported so the controller can retry one failed object in place.
 *
 * @param {import('./schema.js').DioramaObject} object
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {(objectId:string, patch:{status:string, glbUrl?:string})=>void} [opts.onObject]
 * @returns {Promise<{status:'ready'|'failed', glbUrl:string|null}>}
 */
export async function forgeObject(object, { signal, onObject } = {}) {
	onObject?.(object.id, { status: 'forging' });
	try {
		const glbUrl = await runForge(object.prompt, signal);
		if (glbUrl) {
			onObject?.(object.id, { status: 'ready', glbUrl });
			return { status: 'ready', glbUrl };
		}
	} catch (err) {
		if (err?.name === 'AbortError') throw err;
		// Any other failure is non-fatal: this object simply didn't materialize.
	}
	onObject?.(object.id, { status: 'failed' });
	return { status: 'failed', glbUrl: null };
}

// Kick a single free-lane forge and resolve to a durable GLB url (or throw).
async function runForge(prompt, signal) {
	const res = await fetch(FORGE_ENDPOINT, {
		method: 'POST',
		headers: forgeHeaders(),
		body: JSON.stringify({ prompt, tier: 'draft', path: 'image' }),
		signal,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data?.message || `The forge returned ${res.status}.`);
	}
	// The sync lane can return the finished mesh immediately (job_id null).
	if (data.status === 'done' && data.glb_url) return data.glb_url;
	if (data.status === 'failed') throw new Error(data.error || 'Forge failed.');
	if (!data.job_id) throw new Error('The forge did not start a job.');
	return pollForge(data.job_id, signal);
}

// Poll a queued forge job until it produces a mesh, fails, or hits the deadline.
async function pollForge(jobId, signal) {
	const deadline = Date.now() + FORGE_DEADLINE_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS, signal);
		const res = await fetch(`${FORGE_ENDPOINT}?job=${encodeURIComponent(jobId)}`, {
			headers: { 'x-forge-client': CLIENT_ID },
			signal,
		});
		const data = await res.json().catch(() => ({}));
		if (data.status === 'done' && data.glb_url) return data.glb_url;
		if (data.status === 'failed') throw new Error(data.error || 'Forge failed.');
		// queued | running → keep polling.
	}
	throw new Error('This piece took too long to forge.');
}
