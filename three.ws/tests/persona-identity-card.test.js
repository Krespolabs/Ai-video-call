import { describe, it, expect } from 'vitest';
import { buildIdentityCard, summarizeIdentityCard } from '../api/_lib/persona-identity-card.js';

function sampleIdentity() {
	return {
		// Clearly-synthetic placeholder address (CLAUDE.md fixture policy) — not a
		// real mainnet wallet, just a fixed string this pure-function test asserts
		// gets threaded through unchanged.
		address: 'SyntheticTestWallet1111111111111111111111',
		network: 'mainnet',
		explorer: 'https://solscan.io/account/SyntheticTestWallet1111111111111111111111',
		balances: { sol: 1.5, usdc: 12.34, total_usd: 250 },
		reputation: { feedback: { total: 10, verified: 5, disputed: 0, score_avg_verified: 4.4 } },
		holdings: { count: 3, total_usd: 120 },
		fetched_at: '2026-07-08T00:00:00.000Z',
		visual: { reputation_tier: 'trusted', holdings_tier: 'gold', muted: false, verified_name: 'nova.sol' },
	};
}

describe('persona identity card — pure builder', () => {
	it('projects exactly the fields a verifiable card needs, no private key surface', () => {
		const persona = { persona_id: 'persona_cardtest0000001', name: 'Nova' };
		const card = buildIdentityCard({ persona, identity: sampleIdentity() });

		expect(card.personaId).toBe('persona_cardtest0000001');
		expect(card.name).toBe('Nova');
		expect(card.wallet.address).toBe(sampleIdentity().address);
		expect(card.wallet.network).toBe('mainnet');
		expect(card.reputation.tier).toBe('trusted');
		expect(card.holdings.tier).toBe('gold');
		expect(card.verifiedName).toBe('nova.sol');
		expect(card.muted).toBe(false);
		expect(card.fetchedAt).toBe('2026-07-08T00:00:00.000Z');

		// The card is JSON-safe and carries no key material of any kind.
		const json = JSON.stringify(card);
		expect(json).not.toMatch(/secret|privateKey|secretKey/i);
	});

	it('is deterministic over the same input', () => {
		const persona = { persona_id: 'persona_deterministic01', name: 'Echo' };
		const identity = sampleIdentity();
		expect(buildIdentityCard({ persona, identity })).toEqual(buildIdentityCard({ persona, identity }));
	});

	it('summarizeIdentityCard renders a readable one-liner including muted + verified state', () => {
		const persona = { persona_id: 'persona_summarytest001', name: 'Echo' };
		const muted = buildIdentityCard({
			persona,
			identity: { ...sampleIdentity(), visual: { reputation_tier: 'unranked', holdings_tier: 'none', muted: true, verified_name: null } },
		});
		const line = summarizeIdentityCard(muted);
		expect(line).toContain('Echo');
		expect(line).toContain('unranked');
		expect(line).toContain('muted');
		expect(line).not.toContain('verified as');
	});
});
