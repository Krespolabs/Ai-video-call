import { describe, it, expect } from 'vitest';
import { assertGrindFeasible } from '../mcp-server/src/tools/vanity-grinder.js';
import { estimateAttempts } from '../api/_lib/pump-vanity.js';

// Guards the paid `vanity_grinder` MCP tool against an event-loop DoS: a long
// prefix would otherwise grind millions of synchronous keypair generations to
// the cap and time out. The difficulty guard must reject such requests up front.
describe('vanity_grinder difficulty guard', () => {
	it('rejects an over-long (6-char) prefix as too hard', () => {
		const err = assertGrindFeasible({ prefix: 'pump12' });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('vanity_too_hard');
		expect(err.status).toBe(400);
		// Helpful guidance: tell the user to shorten the prefix.
		expect(err.message.toLowerCase()).toMatch(/shorter prefix/);
	});

	it('rejects a 4-char case-sensitive prefix (~58^4, far beyond the cap)', () => {
		expect(estimateAttempts({ prefix: 'abcd' })).toBeGreaterThan(10_000_000);
		const err = assertGrindFeasible({ prefix: 'abcd' });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('vanity_too_hard');
	});

	it('allows a short, feasible prefix within the iteration cap', () => {
		expect(assertGrindFeasible({ prefix: 'abc' })).toBeNull();
		expect(assertGrindFeasible({ prefix: 'ab' })).toBeNull();
		expect(assertGrindFeasible({ prefix: 'a', ignoreCase: true })).toBeNull();
	});

	it('clamps an inflated maxIterations request so it cannot raise the difficulty ceiling', () => {
		// Even if a caller asks for 50M iterations, the guard caps at 1.5M, so a
		// 5-char prefix stays rejected — the cap cannot be bypassed via input.
		const err = assertGrindFeasible({ prefix: 'abcde', maxIterations: 50_000_000 });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('vanity_too_hard');
	});
});
