/**
 * $THREE single-coin compliance guard for the agent-screen browser worker.
 *
 * The worker drives a real browser on the agent's behalf and narrates what it
 * does into the public live-screen feed. A previous revision shipped a default
 * "autonomous" mission that navigated to pump.fun, scanned trending tokens, and
 * pushed their names / symbols / market caps into that public feed — i.e. the
 * platform's own agents surfacing and ranking arbitrary third-party coins. That
 * violates the platform rule that $THREE is the only coin three.ws promotes.
 *
 * The idle loop must stay neutral: it may rest on a home page and say it's
 * standing by, but it must never scan, rank, extract, or narrate third-party
 * tokens or markets. This test pins that invariant at the source level so the
 * token-scanning mission can't quietly come back.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(__dir, '../workers/agent-screen-worker');

function workerSource() {
	return ['index.js', 'config.js', 'capture.js', 'task-runner.js']
		.map((f) => readFileSync(resolve(WORKER_DIR, f), 'utf8'))
		.join('\n');
}

describe('agent-screen worker — $THREE single-coin compliance', () => {
	const src = workerSource();

	it('does not hardcode a pump.fun autonomous navigation target', () => {
		// A user-supplied trade task may still resolve a runtime URL, but the worker
		// must not ship a baked-in pump.fun scan as its default behaviour.
		expect(src).not.toMatch(/PUMP_FUN_URL\s*=/);
		expect(src).not.toMatch(/goto\(\s*PUMP_FUN_URL/);
	});

	it('does not scan, extract, or narrate trending tokens / market caps', () => {
		const forbidden = [
			/trending token/i,
			/top\s+\d*\s*trending/i,
			/market\s*cap/i,
			/marketCap/,
			/holder count/i,
		];
		for (const pattern of forbidden) {
			expect(src, `worker source must not contain ${pattern}`).not.toMatch(pattern);
		}
	});

	it('keeps a neutral idle mission that stands by for a user task', () => {
		// The idle cycle should exist and be content-agnostic.
		expect(src).toMatch(/Standing by/i);
		expect(src).toMatch(/HOME_URL/);
	});
});
