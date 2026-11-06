// Forge observability — structured logs always emit; counters are fail-open.
//
// readGenerationMetrics aggregates hourly Redis buckets into a rollup. With no
// Redis configured (the unit-test default) every primitive must degrade to a
// no-op: events still log, metrics read as null, and nothing throws. That
// fail-open contract is what keeps instrumentation from ever breaking a
// generation, so it's the core of what we assert here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recordGenerationEvent, readGenerationMetrics } from '../../api/_lib/forge-events.js';

describe('forge-events — fail-open without Redis', () => {
	let logSpy;
	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
	});

	it('emits one structured forge_gen log line per event', async () => {
		await recordGenerationEvent({
			phase: 'done',
			backend: 'huggingface',
			tier: 'standard',
			path: 'image',
			latencyMs: 4200,
		});
		expect(logSpy).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(logSpy.mock.calls[0][0]);
		expect(payload).toMatchObject({
			evt: 'forge_gen',
			phase: 'done',
			backend: 'huggingface',
			tier: 'standard',
			path: 'image',
			latency_ms: 4200,
			cache_hit: false,
		});
	});

	it('clamps a negative/invalid latency to null rather than logging a bogus number', async () => {
		await recordGenerationEvent({ phase: 'done', backend: 'trellis', latencyMs: -5 });
		const payload = JSON.parse(logSpy.mock.calls[0][0]);
		expect(payload.latency_ms).toBeNull();
	});

	it('records cache hits in the log line', async () => {
		await recordGenerationEvent({ phase: 'done', backend: 'trellis', cacheHit: true });
		const payload = JSON.parse(logSpy.mock.calls[0][0]);
		expect(payload.cache_hit).toBe(true);
	});

	it('never throws on any phase', async () => {
		await expect(recordGenerationEvent({ phase: 'start', backend: 'nvidia' })).resolves.toBeUndefined();
		await expect(recordGenerationEvent({ phase: 'failed', backend: 'trellis' })).resolves.toBeUndefined();
		await expect(recordGenerationEvent({})).resolves.toBeUndefined();
	});

	it('reads metrics as null when Redis is absent (block omitted, not a fake outage)', async () => {
		await expect(readGenerationMetrics()).resolves.toBeNull();
	});
});
