import { describe, it, expect } from 'vitest';
import { scoreClaim } from '../workers/agent-sniper/claim-scorer.js';

function claim(overrides = {}) {
	return {
		creator: 'Creator1111111111111111111111111111111111111',
		mint: 'THREEsynthetic1111111111111111111111111111111',
		signature: 'sig_abc',
		lamports: 2_000_000_000, // 2 SOL
		ts: 1000,
		...overrides,
	};
}

const ONE_SOL = 1_000_000_000;

describe('scoreClaim — first-claim entry filter', () => {
	it('skips a claim with no resolvable mint', () => {
		const r = scoreClaim(claim({ mint: '' }), {});
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('no_mint');
	});

	it('passes when no claim-size filters are set', () => {
		const r = scoreClaim(claim(), {});
		expect(r.pass).toBe(true);
	});

	it('rejects a claim below min_claim_lamports', () => {
		const r = scoreClaim(claim({ lamports: ONE_SOL }), { min_claim_lamports: '1500000000' });
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('claim_below_min');
	});

	it('rejects a claim above max_claim_lamports', () => {
		const r = scoreClaim(claim({ lamports: 5 * ONE_SOL }), { max_claim_lamports: '3000000000' });
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('claim_above_max');
	});

	it('passes a claim inside [min,max]', () => {
		const r = scoreClaim(claim({ lamports: 2 * ONE_SOL }), {
			min_claim_lamports: '1000000000',
			max_claim_lamports: '3000000000',
		});
		expect(r.pass).toBe(true);
		expect(r.reasons.some((x) => x.startsWith('first_claim_sol:'))).toBe(true);
	});

	it('treats min exactly equal to the claim as a pass (inclusive floor)', () => {
		const r = scoreClaim(claim({ lamports: ONE_SOL }), { min_claim_lamports: '1000000000' });
		expect(r.pass).toBe(true);
	});

	it('handles a missing/zero lamports amount without throwing', () => {
		const r = scoreClaim(claim({ lamports: 0 }), { min_claim_lamports: '1' });
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('claim_below_min');
	});

	it('ignores numeric column values coming back from postgres as decimals', () => {
		// numeric(40,0) can arrive as a string; bigOrNull must tolerate it.
		const r = scoreClaim(claim({ lamports: 2 * ONE_SOL }), { min_claim_lamports: '1000000000.0' });
		expect(r.pass).toBe(true);
	});
});
