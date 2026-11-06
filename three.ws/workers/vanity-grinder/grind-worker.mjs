// Worker thread — pure grinding, no secret persistence.
//
// The main thread (grind.mjs) owns all sealing and writing so secret handling
// stays centralized. A worker only receives a target, grinds it to completion in
// the WASM engine, and posts the raw keypair back over the in-process thread
// channel (never to disk, never to a log). It then waits for the next target.
//
// Protocol:
//   main → worker:  { type: 'grind', target }
//   worker → main:  { type: 'ready' }
//                   { type: 'found', target, publicKey, secretKey, attempts, durationMs }
//                   { type: 'progress', attempts }
//
// STOP is signalled out-of-band via a SharedArrayBuffer atomic (workerData.stopBuffer),
// NOT a message: the grind loop is synchronous and never yields to this worker's
// event loop mid-target, so a queued 'stop' message would not be seen until the
// target completed. The atomic is read directly inside the sync loop.

import { parentPort, workerData } from 'node:worker_threads';
import { grindToCompletion } from './wasm-grind.mjs';

// Shared stop flag: the main thread writes 1 to abort every worker at once; each
// reads it between grind batches. Tolerate its absence (older callers) by falling
// back to a never-stop flag — the maxAttempts cap still bounds every target.
const stopFlag = workerData?.stopBuffer ? new Int32Array(workerData.stopBuffer) : null;
const stopRequested = () => (stopFlag ? Atomics.load(stopFlag, 0) !== 0 : false);
const PROGRESS_EVERY = 2_000_000; // report roughly every ~80s of single-thread work
// Give up on a target after this many attempts — a rare Base58 leading char can be
// effectively unreachable, and an unbounded grind would pin a worker forever.
// Default 200M (~2.2 hours single-thread) comfortably clears a 5-char pattern
// (~656M expected is set higher via env for dedicated 5-char runs).
const MAX_ATTEMPTS_PER_TARGET = parseInt(process.env.MAX_ATTEMPTS_PER_TARGET || '200000000', 10);

parentPort.on('message', (msg) => {
	if (!msg || typeof msg !== 'object') return;
	if (msg.type === 'grind') {
		let lastReported = 0;
		const result = grindToCompletion(msg.target, {
			stopRequested,
			maxAttempts: MAX_ATTEMPTS_PER_TARGET,
			onProgress: (attempts) => {
				if (attempts - lastReported >= PROGRESS_EVERY) {
					lastReported = attempts;
					parentPort.postMessage({ type: 'progress', attempts: PROGRESS_EVERY, worker: workerData?.index });
				}
			},
		});
		if (result.status === 'found') {
			parentPort.postMessage(
				{
					type: 'found',
					target: msg.target,
					publicKey: result.publicKey,
					secretKey: result.secretKey,
					attempts: result.attempts,
					durationMs: result.durationMs,
				},
				// Transfer the secret-key buffer instead of copying it — one owner at a time.
				[result.secretKey.buffer],
			);
			return;
		}
		// 'preempted' → retry next run (don't mark done). 'exhausted' → give up
		// permanently (mark done so resume skips this near-impossible target).
		parentPort.postMessage({ type: result.status === 'exhausted' ? 'exhausted' : 'aborted', target: msg.target, attempts: result.attempts });
	}
});

parentPort.postMessage({ type: 'ready' });
