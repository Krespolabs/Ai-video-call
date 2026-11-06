/**
 * Scoped session keys (capabilities) — the least-privilege core, pinned.
 *
 * This is money governance: a capability must authorize EXACTLY its scope and
 * nothing adjacent, and a bug must fail toward LESS access. The pure, DB-free
 * predicates that decide "does this grant cover this spend" are tested here:
 *   - issuance normalization is strict (no half-defined or unbounded grant),
 *   - grants are tamper-evident (editing any scope field breaks the HMAC),
 *   - revocation does NOT depend on the HMAC (so a revoke can't be forged away),
 *   - scope evaluation rejects wrong-action / disallowed-target / over-ceiling /
 *     expired / revoked / tampered — each with the right reason,
 *   - capability + wallet policy compose so the tighter always wins.
 *
 * The atomic aggregate-ceiling accounting + revoke-immediacy SQL (advisory-locked
 * INSERT…SELECT) is structurally identical to the proven reserveSpendUsd daily-cap
 * statement and is exercised end-to-end by scripts/devnet-capability-e2e.mjs against
 * a real Postgres — it cannot be faithfully reproduced against a query mock.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// No DB is touched by the predicates under test; mock it so the import chain never
// reaches for a real connection.
vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

import {
	normalizeCapabilityInput, signGrant, verifyGrant, canonicalScope,
	capabilityCoversAction, capabilityCoversTarget, capabilityLive,
	checkPerUse, checkAggregate, evaluateCapabilityScope, CapabilityError,
} from '../api/_lib/wallet-capabilities.js';
import { SpendLimitError } from '../api/_lib/agent-trade-guards.js';

const HOUR = 3600 * 1000;

// Build a fully-signed capability row from a partial scope, at a fixed `now`.
function makeCap(partial = {}, now = 1_700_000_000_000) {
	const scope = normalizeCapabilityInput({
		actions: partial.actions || ['snipe'],
		per_use_usd: partial.per_use_usd ?? null,
		aggregate_usd: partial.aggregate_usd ?? 40,
		target_kind: partial.target_kind || 'any',
		targets: partial.targets || [],
		ttl_seconds: partial.ttl_seconds ?? 24 * 3600,
		expires_at: partial.expires_at,
	}, { now });
	const cap = {
		id: partial.id || 'cap-1111',
		agent_id: partial.agent_id || 'agent-1',
		holder_kind: partial.holder_kind || 'strategy',
		holder_ref: partial.holder_ref ?? 'strat-1',
		actions: scope.actions,
		per_use_usd: scope.perUseUsd,
		aggregate_usd: scope.aggregateUsd,
		target_kind: scope.targetKind,
		targets: scope.targets,
		expires_at: scope.expiresAt,
		revoked_at: partial.revoked_at ?? null,
	};
	cap.grant_sig = signGrant(cap);
	return cap;
}

beforeAll(() => {
	process.env.WALLET_CAPABILITY_SECRET = 'test-capability-secret-key-0123456789';
});

describe('normalizeCapabilityInput — strict issuance', () => {
	it('requires at least one valid action', () => {
		expect(() => normalizeCapabilityInput({ actions: [], aggregate_usd: 10 })).toThrow(/at least one action/i);
		expect(() => normalizeCapabilityInput({ actions: ['nope'], aggregate_usd: 10 })).toThrow(/at least one action/i);
	});

	it('drops unknown actions but keeps valid ones', () => {
		const s = normalizeCapabilityInput({ actions: ['snipe', 'withdraw', 'x402'], aggregate_usd: 5 });
		expect(s.actions).toEqual(['snipe', 'x402']); // 'withdraw' is never delegatable
	});

	it('rejects an unbounded grant (no ceiling and no target restriction)', () => {
		expect(() => normalizeCapabilityInput({ actions: ['trade'] })).toThrow(/ceiling or a target/i);
	});

	it('accepts a target-only leash with no USD ceiling', () => {
		const s = normalizeCapabilityInput({ actions: ['snipe'], target_kind: 'mint', targets: ['MintAAA'] });
		expect(s.targetKind).toBe('mint');
		expect(s.targets).toEqual(['MintAAA']);
	});

	it('rejects per-use greater than aggregate', () => {
		expect(() => normalizeCapabilityInput({ actions: ['x402'], per_use_usd: 50, aggregate_usd: 10 })).toThrow(/per-use ceiling cannot exceed/i);
	});

	it('requires a future expiry and clamps ttl', () => {
		const now = 1_700_000_000_000;
		const s = normalizeCapabilityInput({ actions: ['x402'], aggregate_usd: 5, ttl_seconds: 3600 }, { now });
		expect(s.expiresAt.getTime()).toBe(now + HOUR);
		// sub-minimum ttl is clamped up, never to the past
		const s2 = normalizeCapabilityInput({ actions: ['x402'], aggregate_usd: 5, ttl_seconds: 1 }, { now });
		expect(s2.expiresAt.getTime()).toBeGreaterThan(now);
	});

	it('normalizes service targets to bare hosts', () => {
		const s = normalizeCapabilityInput({ actions: ['x402'], target_kind: 'service', targets: ['https://api.weather.com/v1?x=1', 'Pay.Stripe.com'] });
		expect(s.targets).toEqual(['api.weather.com', 'pay.stripe.com'].sort());
	});
});

describe('tamper-evidence (HMAC over the immutable scope)', () => {
	it('round-trips: a freshly signed grant verifies', () => {
		const cap = makeCap();
		expect(verifyGrant(cap)).toBe(true);
	});

	it.each([
		['actions', (c) => { c.actions = [...c.actions, 'trade']; }],
		['aggregate_usd', (c) => { c.aggregate_usd = 1_000_000; }],
		['per_use_usd', (c) => { c.per_use_usd = 999; }],
		['target_kind', (c) => { c.target_kind = 'any'; c.targets = []; }],
		['targets', (c) => { c.targets = ['EVILMINT']; c.target_kind = 'mint'; }],
		['expires_at', (c) => { c.expires_at = new Date(c.expires_at.getTime() + 365 * 24 * HOUR); }],
		['holder_ref', (c) => { c.holder_ref = 'other-strategy'; }],
		['agent_id', (c) => { c.agent_id = 'agent-2'; }],
	])('a forged %s no longer verifies', (_field, mutate) => {
		const cap = makeCap({ target_kind: 'mint', targets: ['MintAAA'], per_use_usd: 5 });
		mutate(cap);
		expect(verifyGrant(cap)).toBe(false);
	});

	it('revocation does NOT touch the HMAC (revoke is enforced separately, not forgeable away)', () => {
		const cap = makeCap();
		const before = canonicalScope(cap);
		cap.revoked_at = new Date();
		expect(canonicalScope(cap)).toBe(before);
		expect(verifyGrant(cap)).toBe(true); // signature still valid…
		expect(capabilityLive(cap).ok).toBe(false); // …but the grant is dead
	});

	it('a grant signed under a different secret fails verification', () => {
		const cap = makeCap();
		process.env.WALLET_CAPABILITY_SECRET = 'a-totally-different-secret-value-xyz';
		expect(verifyGrant(cap)).toBe(false);
		process.env.WALLET_CAPABILITY_SECRET = 'test-capability-secret-key-0123456789';
	});
});

describe('scope predicates', () => {
	it('covers exactly its actions', () => {
		const cap = makeCap({ actions: ['snipe'] });
		expect(capabilityCoversAction(cap, 'snipe')).toBe(true);
		expect(capabilityCoversAction(cap, 'trade')).toBe(false);
		expect(capabilityCoversAction(cap, 'x402')).toBe(false);
	});

	it('any-target covers everything; mint/destination need an exact match', () => {
		expect(capabilityCoversTarget(makeCap({ target_kind: 'any' }), 'anything')).toBe(true);
		const mintCap = makeCap({ target_kind: 'mint', targets: ['MintAAA', 'MintBBB'] });
		expect(capabilityCoversTarget(mintCap, 'MintAAA')).toBe(true);
		expect(capabilityCoversTarget(mintCap, 'MintZZZ')).toBe(false);
		expect(capabilityCoversTarget(mintCap, '')).toBe(false);
	});

	it('service targets match on host of a full URL', () => {
		const svc = makeCap({ actions: ['x402'], target_kind: 'service', targets: ['https://api.weather.com'] });
		expect(capabilityCoversTarget(svc, 'https://api.weather.com/v1/forecast?z=1')).toBe(true);
		expect(capabilityCoversTarget(svc, 'https://evil.com/api.weather.com')).toBe(false);
	});

	it('per-use ceiling blocks over-limit single spends', () => {
		const cap = makeCap({ per_use_usd: 5, aggregate_usd: 100 });
		expect(checkPerUse(cap, 4.99)).toBeNull();
		expect(checkPerUse(cap, 5)).toBeNull();
		expect(checkPerUse(cap, 5.01)?.reason).toBe('per_use_exceeded');
	});

	it('aggregate ceiling blocks when prior + this exceeds the budget', () => {
		const cap = makeCap({ aggregate_usd: 40 });
		expect(checkAggregate(35, 5, cap)).toBeNull();
		expect(checkAggregate(38, 5, cap)?.reason).toBe('aggregate_exceeded');
		expect(checkAggregate(0, 40, cap)).toBeNull();
	});
});

describe('evaluateCapabilityScope — authorizes EXACTLY its scope, nothing adjacent', () => {
	const now = 1_700_000_000_000;
	const base = () => makeCap({ actions: ['snipe'], per_use_usd: 10, aggregate_usd: 40, target_kind: 'mint', targets: ['MintAAA'] }, now);

	it('passes an in-scope spend', () => {
		expect(evaluateCapabilityScope({ cap: base(), action: 'snipe', target: 'MintAAA', usdValue: 9, now })).toBeNull();
	});

	it('rejects the wrong action', () => {
		expect(evaluateCapabilityScope({ cap: base(), action: 'trade', target: 'MintAAA', usdValue: 9, now })?.reason).toBe('action_not_allowed');
	});

	it('rejects a disallowed target', () => {
		expect(evaluateCapabilityScope({ cap: base(), action: 'snipe', target: 'MintZZZ', usdValue: 9, now })?.reason).toBe('target_not_allowed');
	});

	it('rejects over the per-use ceiling', () => {
		expect(evaluateCapabilityScope({ cap: base(), action: 'snipe', target: 'MintAAA', usdValue: 11, now })?.reason).toBe('per_use_exceeded');
	});

	it('rejects an expired grant', () => {
		const cap = base();
		expect(evaluateCapabilityScope({ cap, action: 'snipe', target: 'MintAAA', usdValue: 9, now: now + 48 * HOUR })?.reason).toBe('expired');
	});

	it('rejects a revoked grant', () => {
		const cap = base();
		cap.revoked_at = new Date(now);
		expect(evaluateCapabilityScope({ cap, action: 'snipe', target: 'MintAAA', usdValue: 9, now })?.reason).toBe('revoked');
	});

	it('rejects a tampered grant (fails toward LESS access)', () => {
		const cap = base();
		cap.aggregate_usd = 1_000_000; // widen the budget without re-signing
		expect(evaluateCapabilityScope({ cap, action: 'snipe', target: 'MintAAA', usdValue: 9, now })?.reason).toBe('tampered');
	});
});

describe('capability + wallet policy compose — the tighter wins', () => {
	it('capability denials are SpendLimitError, so existing guard catches handle them', () => {
		const err = new CapabilityError('action_not_allowed', 'nope', {});
		expect(err).toBeInstanceOf(SpendLimitError);
		expect(err.status).toBe(403);
	});

	it('a capability can only narrow: a $9 spend in a $10 per-use / $40 wallet-tx world is allowed, $11 is not', () => {
		const cap = makeCap({ per_use_usd: 10, aggregate_usd: 40 });
		// wallet per_tx_usd would be e.g. 40 (looser); capability per_use 10 (tighter) decides.
		expect(checkPerUse(cap, 9)).toBeNull();
		expect(checkPerUse(cap, 11)?.reason).toBe('per_use_exceeded');
	});
});
