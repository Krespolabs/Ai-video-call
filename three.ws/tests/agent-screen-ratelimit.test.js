/**
 * Regression guard for the live-agent screen feature's rate limiters.
 *
 * The screen feed is wired across three endpoints that all gate on the same
 * generic per-IP bucket: api/agent-screen-active.js (roster), agent-screen-push.js
 * (frame ingest), agent-task.js (task queue). A previous revision referenced
 * `limits.apiIp` — a key that did not exist on the limits object — so every one of
 * those endpoints threw `limits.apiIp is not a function` uncaught, producing a hard
 * FUNCTION_INVOCATION_FAILED in production and silently killing the entire feature.
 *
 * These tests pin the limiter contract so that regression can't recur unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { limits } from '../api/_lib/rate-limit.js';

describe('limits.apiIp — generic app endpoint bucket', () => {
	it('exists and is callable', () => {
		expect(typeof limits.apiIp).toBe('function');
	});

	it('resolves a limiter decision for a bare call (roster poll shape)', async () => {
		const res = await limits.apiIp('1.2.3.4');
		expect(res).toBeTruthy();
		expect(typeof res.success).toBe('boolean');
	});

	it('honors a per-caller override (push stream / task queue shapes)', async () => {
		const push = await limits.apiIp('1.2.3.5', { limit: 360, window: '60s' });
		const task = await limits.apiIp('1.2.3.6', { limit: 20, window: '60s' });
		expect(typeof push.success).toBe('boolean');
		expect(typeof task.success).toBe('boolean');
	});

	it('keeps the buckets the screen feature depends on present', () => {
		// Every limiter referenced by the screen/task endpoints must exist, or the
		// endpoint that calls it 500s at the limiter line before any work happens.
		for (const key of ['apiIp', 'mcpIp']) {
			expect(typeof limits[key]).toBe('function');
		}
	});
});
