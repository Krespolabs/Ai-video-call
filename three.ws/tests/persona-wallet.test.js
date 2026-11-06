import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

process.env.JWT_SECRET ||= 'test-jwt-secret-not-a-real-secret-0123456789';
process.env.PERSONA_WALLET_SECRET ||= 'test-persona-wallet-secret-0123456789';

// Fully mock every network/DB boundary persona-wallet.js reads through, so the
// "identity read degrades gracefully" tests are deterministic and instant —
// they exercise the catch branches directly rather than hoping a sandboxed
// test runner's real RPC/DB calls fail fast.
vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: () => ({
		getBalance: vi.fn(async () => { throw new Error('rpc unavailable in test'); }),
		getTokenAccountBalance: vi.fn(async () => { throw new Error('rpc unavailable in test'); }),
	}),
}));
vi.mock('../api/_lib/portfolio.js', () => ({
	valuateHoldings: vi.fn(async () => { throw new Error('portfolio rpc unavailable in test'); }),
}));
vi.mock('../api/_mcp/tools/solana.js', () => ({
	solanaReputation: vi.fn(async () => { throw new Error('no db in test'); }),
}));
vi.mock('../api/_lib/avatar-wallet.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, solUsdPrice: vi.fn(async () => { throw new Error('no price feed in test'); }) };
});

const {
	personaWalletAddress,
	reputationTierFor,
	holdingsTierFor,
	isMutedBalance,
	getPersonaIdentity,
	sendPersonaUsdc,
} = await import('../api/_lib/persona-wallet.js');

describe('persona wallet — deterministic binding', () => {
	it('the SAME persona_id always derives the SAME address', () => {
		const a1 = personaWalletAddress('persona_abc123def456ghi7');
		const a2 = personaWalletAddress('persona_abc123def456ghi7');
		expect(a1).toBe(a2);
	});

	it('different persona_ids derive DIFFERENT addresses', () => {
		const a = personaWalletAddress('persona_abc123def456ghi7');
		const b = personaWalletAddress('persona_zzz999yyy888xxx7');
		expect(a).not.toBe(b);
	});

	it('produces a real, valid Solana public key', () => {
		const addr = personaWalletAddress('persona_validpubkeycheck1');
		expect(() => new PublicKey(addr)).not.toThrow();
	});

	it('is stable across repeated derivations (no hidden randomness)', () => {
		const addrs = new Set();
		for (let i = 0; i < 20; i++) addrs.add(personaWalletAddress('persona_repeatstability0'));
		expect(addrs.size).toBe(1);
	});

	it('does not export any function that could hand back key material', async () => {
		const mod = await import('../api/_lib/persona-wallet.js');
		const exported = Object.keys(mod);
		expect(exported).not.toContain('derivePersonaSeed');
		expect(exported).not.toContain('withPersonaKeypair');
		expect(exported).not.toContain('derivePersonaKeypair');
	});
});

describe('persona wallet — visual tier pure functions', () => {
	it('reputationTierFor: unranked with zero feedback', () => {
		expect(reputationTierFor({ feedback: { total: 0, verified: 0, disputed: 0, score_avg_verified: 0 } })).toBe('unranked');
	});
	it('reputationTierFor: emerging with unverified feedback', () => {
		expect(reputationTierFor({ feedback: { total: 2, verified: 0, disputed: 0, score_avg_verified: 0 } })).toBe('emerging');
	});
	it('reputationTierFor: trusted at 3+ verified with a good average', () => {
		expect(reputationTierFor({ feedback: { total: 5, verified: 3, disputed: 0, score_avg_verified: 4.2 } })).toBe('trusted');
	});
	it('reputationTierFor: eminent at 15+ verified with a high average', () => {
		expect(reputationTierFor({ feedback: { total: 20, verified: 16, disputed: 0, score_avg_verified: 4.8 } })).toBe('eminent');
	});
	it('reputationTierFor: disputed when disputes dominate', () => {
		expect(reputationTierFor({ feedback: { total: 5, verified: 2, disputed: 3, score_avg_verified: 3 } })).toBe('disputed');
	});

	it('holdingsTierFor buckets by USD total', () => {
		expect(holdingsTierFor(0)).toBe('none');
		expect(holdingsTierFor(5)).toBe('bronze');
		expect(holdingsTierFor(50)).toBe('silver');
		expect(holdingsTierFor(500)).toBe('gold');
		expect(holdingsTierFor(5000)).toBe('platinum');
	});

	it('isMutedBalance is true under the USD floor', () => {
		expect(isMutedBalance({ sol: 0, usdc: 0, total_usd: 0 })).toBe(true);
		expect(isMutedBalance({ sol: 0.001, usdc: 0, total_usd: 0.001 })).toBe(true);
		expect(isMutedBalance({ sol: 1, usdc: 10, total_usd: 150 })).toBe(false);
	});
});

describe('persona wallet — identity read degrades gracefully', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('never throws when every upstream (RPC, portfolio, reputation, price, SNS) is down', async () => {
		const identity = await getPersonaIdentity('persona_gracefuldegrade01', { network: 'devnet' });
		expect(identity).toMatchObject({
			persona_id: 'persona_gracefuldegrade01',
			balances: { sol: 0, usdc: 0 },
			holdings: { count: 0, total_usd: 0 },
			nameplate: { name: null, verified: false },
			visual: { reputation_tier: 'unranked', holdings_tier: 'none', muted: true, verified_name: null },
		});
		// A real, valid address is still derived even though every read degraded.
		expect(() => new PublicKey(identity.address)).not.toThrow();
	});

	it('reports the honest degraded reputation shape (never a fabricated non-zero)', async () => {
		const identity = await getPersonaIdentity('persona_degradedreputation1');
		expect(identity.reputation.degraded).toBe(true);
		expect(identity.reputation.feedback.total).toBe(0);
	});
});

describe('persona wallet — value-op guardrails (short-circuit before any network call)', () => {
	it('rejects a bad destination address', async () => {
		const res = await sendPersonaUsdc({ personaId: 'persona_badaddr0000000001', to: 'not-a-real-address', usdc: 0.1 });
		expect(res.status).toBe('failed');
		expect(res.code).toBe('bad_address');
	});

	it('rejects a self-payment', async () => {
		const self = personaWalletAddress('persona_selfpay000000001');
		const res = await sendPersonaUsdc({ personaId: 'persona_selfpay000000001', to: self, usdc: 0.1 });
		expect(res.status).toBe('failed');
		expect(res.code).toBe('self_payment');
	});

	it('blocks a call above the per-call USDC cap before any signature is built', async () => {
		const dest = personaWalletAddress('persona_capdestination01');
		const res = await sendPersonaUsdc({
			personaId: 'persona_capsourceover0001',
			to: dest,
			usdc: 1_000_000, // absurdly over any sane per-call cap
			sessionId: 'test-session-cap-' + Date.now(),
		});
		expect(res.status).toBe('blocked');
		expect(res.code).toBe('over_call_cap');
	});
});
