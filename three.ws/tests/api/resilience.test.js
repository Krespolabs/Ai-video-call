/**
 * Shared resilience helper (api/_lib/resilience.js) — the cockatiel-backed
 * circuit breaker that external call sites use to fail fast and degrade during an
 * upstream outage. These pin the contract: success passes through, failures
 * degrade to the fallback, and after `threshold` consecutive failures the circuit
 * opens and stops invoking the operation entirely.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { withBreaker, isCircuitError, _resetBreakers } from '../../api/_lib/resilience.js';
import { BrokenCircuitError } from 'cockatiel';

beforeEach(() => _resetBreakers());

describe('withBreaker', () => {
	it('returns the operation result on success', async () => {
		expect(await withBreaker('t:ok', async () => 42, { fallback: -1 })).toBe(42);
	});

	it('degrades to the fallback when the operation throws', async () => {
		const r = await withBreaker('t:fail', async () => {
			throw new Error('boom');
		}, { fallback: 'fb' });
		expect(r).toBe('fb');
	});

	it('supports a fallback factory that sees the error', async () => {
		const r = await withBreaker(
			't:fail2',
			async () => {
				throw new Error('boom');
			},
			{ fallback: (e) => `caught:${e.message}` },
		);
		expect(r).toBe('caught:boom');
	});

	it('opens the circuit after `threshold` consecutive failures and stops calling the op', async () => {
		let calls = 0;
		const op = async () => {
			calls++;
			throw new Error('down');
		};
		const run = () =>
			withBreaker('t:breaker', op, { fallback: null, threshold: 3, halfOpenAfterMs: 60_000 });

		await run();
		await run();
		await run(); // 3rd consecutive failure → circuit opens
		expect(calls).toBe(3);

		const r = await run(); // open → short-circuits WITHOUT invoking op
		expect(r).toBeNull();
		expect(calls).toBe(3);
	});

	it('flags an open-circuit rejection via isCircuitError', async () => {
		const op = async () => {
			throw new Error('down');
		};
		const opts = { threshold: 2, halfOpenAfterMs: 60_000, fallback: (e) => e };
		await withBreaker('t:flag', op, opts);
		await withBreaker('t:flag', op, opts); // opens
		const err = await withBreaker('t:flag', op, opts); // open → returns the circuit error
		expect(err).toBeInstanceOf(BrokenCircuitError);
		expect(isCircuitError(err)).toBe(true);
	});

	it('isolates breakers by name (one open upstream does not trip another)', async () => {
		const bad = () => withBreaker('t:bad', async () => { throw new Error('x'); }, { fallback: 'fb', threshold: 1, halfOpenAfterMs: 60_000 });
		await bad(); // opens t:bad
		// A different name is unaffected and still executes.
		expect(await withBreaker('t:good', async () => 'ok', { fallback: 'fb' })).toBe('ok');
	});
});
