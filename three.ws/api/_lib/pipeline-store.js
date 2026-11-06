// Pipeline job store — durable state for the /api/x402/pipeline asset factory.
//
// A pipeline job runs an ordered chain of stages (generate → rig → optimize …)
// as ONE paid job. Because Vercel functions are stateless and there is no
// background worker, the chain is a poll-driven state machine: each free poll of
// GET /api/forge?job=<pipeline-token> advances the current stage and kicks the
// next one when it finishes (see advancePipeline in ./pipeline.js). That means
// the job record must survive between two separate serverless invocations, so it
// lives in the shared cache (Upstash Redis when configured, in-process memory
// otherwise — the same durability posture forge-scale/forge-cache already use).
//
// Fail-soft: without Redis the record is single-instance only. That's honest
// degradation, not a bug — polling still works within one warm instance, and a
// multi-instance deployment sets UPSTASH_REDIS_REST_URL to make it durable.

import { randomUUID } from 'node:crypto';

import { cacheGet, cacheGetFresh, cacheSet, acquireLock } from './cache.js';

const KEY_PREFIX = 'pipeline:job:';
const LOCK_PREFIX = 'pipeline:lock:';

// A pipeline completes in minutes; keep the record for two hours so a slow chain
// (cold self-host workers) and a client that polls lazily both resolve, then let
// it self-prune.
const JOB_TTL_S = 2 * 3600;
// The advance critical section (poll current stage + submit next) is quick; the
// lock only needs to outlive one advance so two concurrent polls can't double-
// submit the same next stage. Auto-expires if a lambda dies mid-advance.
const LOCK_TTL_S = 90;

function keyFor(id) {
	return `${KEY_PREFIX}${id}`;
}

// Terminal states never advance again.
export function isTerminal(status) {
	return status === 'done' || status === 'failed';
}

// Create a fresh pipeline job record. `stages` is the validated, ordered stage
// id list; every stage starts `queued` with null timings/outputs so a poll can
// see the whole plan from the first request. Returns the persisted record (with
// its generated id) or null when the store write itself failed.
export async function createPipelineJob({ stages, prompt, glbUrl, options, priceUsdc, priceAtomics, network }) {
	const id = randomUUID();
	const now = new Date().toISOString();
	const record = {
		id,
		version: 1,
		status: 'queued',
		created_at: now,
		updated_at: now,
		prompt: prompt ?? null,
		input_glb_url: glbUrl ?? null,
		options: options && typeof options === 'object' ? options : {},
		price_usdc: priceUsdc ?? null,
		price_atomics: priceAtomics ?? null,
		network: network ?? null,
		// The most recent successful stage output — the caller's "current best" GLB,
		// available even on a later stage's failure (honest partial value).
		result_glb_url: null,
		stages: stages.map((sid) => ({
			id: sid,
			status: 'queued',
			started_at: null,
			finished_at: null,
			output_url: null,
			error: null,
			// Internal poll handle for the running stage (provider + upstream id);
			// stripped from the public poll response.
			handle: null,
		})),
	};
	const ok = await savePipelineJob(record);
	return ok ? record : null;
}

// Load a job record. Uses the fresh read (bypasses the short read-memo) so a
// poll immediately after a sibling poll's write doesn't see a stale snapshot.
export async function getPipelineJob(id) {
	if (!id) return null;
	const record = await cacheGetFresh(keyFor(id));
	return record && typeof record === 'object' ? record : null;
}

// Non-fresh read for callers that don't need the very latest write (discovery,
// idempotent reads). Kept distinct so the hot poll path is explicit about using
// the fresh variant.
export async function peekPipelineJob(id) {
	if (!id) return null;
	const record = await cacheGet(keyFor(id));
	return record && typeof record === 'object' ? record : null;
}

export async function savePipelineJob(record) {
	if (!record?.id) return false;
	record.updated_at = new Date().toISOString();
	try {
		await cacheSet(keyFor(record.id), record, JOB_TTL_S);
		return true;
	} catch {
		return false;
	}
}

// Best-effort advance lock so two concurrent polls of the same job don't both
// submit its next stage. Returns true when THIS caller holds the lock (or when
// no Redis is configured — a single instance needs no cross-instance lock).
export async function acquireAdvanceLock(id) {
	return acquireLock(`${LOCK_PREFIX}${id}`, LOCK_TTL_S);
}

// Strip internal fields (per-stage poll handles) from a record before it goes
// over the wire. The handle names the upstream provider + task id — internal
// routing state, never shown to the buyer.
export function publicView(record) {
	if (!record) return null;
	return {
		job_id: record.id,
		status: record.status,
		created_at: record.created_at,
		updated_at: record.updated_at,
		prompt: record.prompt,
		result_glb_url: record.result_glb_url,
		price_usdc: record.price_usdc,
		stages: record.stages.map((s) => ({
			id: s.id,
			status: s.status,
			started_at: s.started_at,
			finished_at: s.finished_at,
			output_url: s.output_url,
			error: s.error,
		})),
	};
}
