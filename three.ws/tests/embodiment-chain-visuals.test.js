import { describe, it, expect } from 'vitest';
import { mapChainStateToVisuals } from '../apps-sdk/embodiment/chain-visuals.js';

function identity(visual) {
	return { visual: { reputation_tier: 'unranked', holdings_tier: 'none', muted: false, verified_name: null, ...visual } };
}

describe('chain-visuals — mapChainStateToVisuals', () => {
	it('has a designed mapping for every reputation tier, including unranked', () => {
		for (const tier of ['unranked', 'emerging', 'trusted', 'eminent', 'disputed']) {
			const v = mapChainStateToVisuals(identity({ reputation_tier: tier }));
			expect(v.aura.tier).toBe(tier);
			expect(typeof v.aura.color).toBe('string');
			expect(v.aura.intensity).toBeGreaterThanOrEqual(0);
		}
	});

	it('has a designed cosmetic for every holdings tier, including none', () => {
		for (const tier of ['none', 'bronze', 'silver', 'gold', 'platinum']) {
			const v = mapChainStateToVisuals(identity({ holdings_tier: tier }));
			expect(v.cosmetic.tier).toBe(tier);
			expect(typeof v.cosmetic.color).toBe('string');
		}
	});

	it('muted balance dims the aura regardless of reputation tier', () => {
		const bright = mapChainStateToVisuals(identity({ reputation_tier: 'eminent', muted: false }));
		const dimmed = mapChainStateToVisuals(identity({ reputation_tier: 'eminent', muted: true }));
		expect(dimmed.aura.intensity).toBeLessThan(bright.aura.intensity);
		expect(dimmed.muted).toBe(true);
	});

	it('carries a verified nameplate through untouched', () => {
		const v = mapChainStateToVisuals(identity({ verified_name: 'agent.sol' }));
		expect(v.nameplate).toBe('agent.sol');
	});

	it('nameplate is null when no verified name resolved', () => {
		const v = mapChainStateToVisuals(identity({ verified_name: null }));
		expect(v.nameplate).toBeNull();
	});

	it('degrades to the unranked/none/unmuted baseline on garbage input — never throws', () => {
		expect(() => mapChainStateToVisuals(null)).not.toThrow();
		expect(() => mapChainStateToVisuals(undefined)).not.toThrow();
		expect(() => mapChainStateToVisuals({})).not.toThrow();
		expect(() => mapChainStateToVisuals({ visual: { reputation_tier: 'not-a-real-tier' } })).not.toThrow();
		const v = mapChainStateToVisuals({});
		expect(v.aura.tier).toBe('unranked');
		expect(v.cosmetic.tier).toBe('none');
		expect(v.muted).toBe(false);
	});

	it('also accepts the visual object directly (not wrapped in an identity envelope)', () => {
		const v = mapChainStateToVisuals({ reputation_tier: 'trusted', holdings_tier: 'gold', muted: false, verified_name: null });
		expect(v.aura.tier).toBe('trusted');
		expect(v.cosmetic.tier).toBe('gold');
	});
});
