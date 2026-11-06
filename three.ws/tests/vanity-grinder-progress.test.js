import { describe, it, expect } from 'vitest';
import { grindMintKeypair } from '../api/_lib/pump-vanity.js';
import { computeGrindStats } from '../api/_lib/vanity-grind-stats.js';

// The live Vanity Address Miner (feature #11) streams real grind numbers to the
// agent screen. These tests pin the contract the on-screen frame depends on:
// onProgress fires with monotonic iterations and a positive instantaneous rate,
// and the attempts/sec stat derives purely from those real numbers.

describe('grindMintKeypair onProgress', () => {
	it('fires progress samples with monotonic iterations and a positive rate', async () => {
		const samples = [];
		// A 3-char suffix is too hard to hit inside the tiny iteration budget, so
		// the grind exhausts maxIterations (throws vanity_timeout) — exactly the
		// path that produces a stream of progress samples with no early match.
		await expect(
			grindMintKeypair({
				suffix: 'xyz',
				maxIterations: 1500,
				progressEvery: 500,
				onProgress: (s) => samples.push(s),
			}),
		).rejects.toMatchObject({ code: 'vanity_timeout' });

		expect(samples.length).toBeGreaterThanOrEqual(2);
		for (let i = 0; i < samples.length; i++) {
			const s = samples[i];
			expect(s.iterations).toBe(500 * (i + 1));
			expect(s.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(s.attemptsPerSec).toBeGreaterThan(0);
			expect(typeof s.sampleAddress).toBe('string');
			expect(s.sampleAddress.length).toBeGreaterThan(30);
			if (i > 0) {
				// iterations and elapsed time only ever move forward.
				expect(s.iterations).toBeGreaterThan(samples[i - 1].iterations);
				expect(s.elapsedMs).toBeGreaterThanOrEqual(samples[i - 1].elapsedMs);
			}
		}
	});

	it('does not fire onProgress when no callback is passed (unchanged behaviour)', async () => {
		// 1-char prefix lands almost immediately; the return shape is untouched.
		const out = await grindMintKeypair({ prefix: 'a', ignoreCase: true });
		expect(out.keypair.publicKey.toBase58().toLowerCase().startsWith('a')).toBe(true);
		expect(out.iterations).toBeGreaterThan(0);
		expect(out.durationMs).toBeGreaterThanOrEqual(0);
	});
});

describe('computeGrindStats', () => {
	it('derives attempts/sec from real iteration/elapsed deltas', () => {
		const stats = computeGrindStats({
			iterations: 4_182_330,
			elapsedMs: 107_000,
			prevIterations: 4_143_430,
			prevElapsedMs: 106_000,
			prefix: 'pump',
		});
		// (4,182,330 - 4,143,430) / (107000 - 106000) * 1000 = 38,900/sec
		expect(stats.attemptsPerSec).toBeCloseTo(38_900, 0);
		expect(stats.expectedIterations).toBe(Math.pow(58, 4));
		expect(stats.progress).toBeGreaterThan(0);
		expect(stats.progress).toBeLessThanOrEqual(1);
	});

	it('clamps progress to 1 and never divides by zero', () => {
		const stats = computeGrindStats({
			iterations: 999_999_999,
			elapsedMs: 1000,
			prevIterations: 999_999_999,
			prevElapsedMs: 1000,
			prefix: 'a',
		});
		expect(stats.progress).toBe(1);
		expect(Number.isFinite(stats.attemptsPerSec)).toBe(true);
		expect(stats.attemptsPerSec).toBeGreaterThanOrEqual(0);
	});
});
