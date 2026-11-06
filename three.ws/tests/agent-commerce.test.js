/**
 * Agent-to-agent commerce — the trust-critical invariants, pinned.
 *
 * The host model can autonomously hire + pay another agent with real USDC, so
 * the pieces that keep that safe and legible are tested here with no network,
 * no wallet, and no model (everything in agent-commerce.js is pure):
 *   - the spend guardrails are TOTAL and fail closed — a caller's maxSpendUsd can
 *     only tighten the hard cap (never raise it), an over-cap / over-threshold /
 *     over-session-budget hire is refused BEFORE any payment settles, and a
 *     malformed price is rejected rather than treated as $0,
 *   - the guard evaluator is PURE — evaluating a hire never mutates the session
 *     ledger (only a settled hire does, via recordSessionSpend),
 *   - the provenance receipt has a stable shape the card renders, names USDC on
 *     Solana mainnet as the settlement rail, and NEVER inlines a fabricated tx
 *     signature — the real on-chain reference is read from _meta at render time.
 *
 * Coin policy: USDC appears only as the settlement unit; $THREE is the only coin
 * the platform promotes. These tests assert no other token leaks into a receipt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
	parseUsd,
	formatUsd,
	guardrailConfig,
	evaluateSpendGuards,
	getSessionSpend,
	getSessionHires,
	recordSessionSpend,
	resetSession,
	buildProvenance,
	SETTLEMENT_ASSET,
	SETTLEMENT_NETWORK,
} from '../mcp-server/src/lib/agent-commerce.js';

// Guardrail env vars these tests pin so the suite is deterministic regardless of
// the operator's deployment config. Saved + restored around each test.
const GUARD_ENV = [
	'MCP_AGENT_HIRE_PRICE_USD',
	'MCP_AGENT_HIRE_MAX_PER_CALL_USD',
	'MCP_AGENT_HIRE_MAX_PER_SESSION_USD',
	'MCP_AGENT_HIRE_CONFIRM_THRESHOLD_USD',
	'MCP_AGENT_HIRE_MIN_REPUTATION',
];

let savedEnv;

beforeEach(() => {
	savedEnv = {};
	for (const k of GUARD_ENV) savedEnv[k] = process.env[k];
	// Pin a known guardrail config: $0.05 hire, $1 per-call cap, $5 session cap,
	// $0.50 confirm threshold, no reputation floor.
	process.env.MCP_AGENT_HIRE_PRICE_USD = '0.05';
	process.env.MCP_AGENT_HIRE_MAX_PER_CALL_USD = '1';
	process.env.MCP_AGENT_HIRE_MAX_PER_SESSION_USD = '5';
	process.env.MCP_AGENT_HIRE_CONFIRM_THRESHOLD_USD = '0.5';
	delete process.env.MCP_AGENT_HIRE_MIN_REPUTATION;
	resetSession();
});

afterEach(() => {
	for (const k of GUARD_ENV) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	resetSession();
});

// ---------------------------------------------------------------------------
// USD parsing / formatting
// ---------------------------------------------------------------------------

describe('USD parsing + formatting', () => {
	it('parses "$0.05", "0.05", and 0.05 identically', () => {
		expect(parseUsd('$0.05')).toBe(0.05);
		expect(parseUsd('0.05')).toBe(0.05);
		expect(parseUsd(0.05)).toBe(0.05);
	});

	it('returns NaN for junk so callers fail closed (never silent $0)', () => {
		for (const bad of [null, undefined, '', '   ', 'abc', '$', NaN, Infinity]) {
			expect(Number.isNaN(parseUsd(bad))).toBe(true);
		}
	});

	it('formats cleanly, trimming trailing zeros past 2 places', () => {
		expect(formatUsd(0.05)).toBe('$0.05');
		expect(formatUsd(1)).toBe('$1');
		expect(formatUsd(0.150000)).toBe('$0.15');
		expect(formatUsd(0.001)).toBe('$0.001');
		expect(formatUsd(NaN)).toBe('$0.00');
	});
});

// ---------------------------------------------------------------------------
// Guardrail config
// ---------------------------------------------------------------------------

describe('guardrailConfig', () => {
	it('reads the pinned env config', () => {
		const cfg = guardrailConfig();
		expect(cfg.hirePriceUsd).toBe(0.05);
		expect(cfg.maxPerCallUsd).toBe(1);
		expect(cfg.maxPerSessionUsd).toBe(5);
		expect(cfg.confirmThresholdUsd).toBe(0.5);
		expect(cfg.minReputation).toBe(0);
	});

	it('falls back to safe defaults when env is unset', () => {
		for (const k of GUARD_ENV) delete process.env[k];
		const cfg = guardrailConfig();
		expect(cfg.hirePriceUsd).toBe(0.05);
		expect(cfg.maxPerCallUsd).toBe(1);
		expect(cfg.maxPerSessionUsd).toBe(5);
		expect(cfg.confirmThresholdUsd).toBe(0.5);
		expect(cfg.minReputation).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Spend guardrails — the money-safety core
// ---------------------------------------------------------------------------

describe('evaluateSpendGuards — spend caps', () => {
	it('allows an ordinary hire under every cap', () => {
		const v = evaluateSpendGuards({ priceUsd: 0.05, sessionId: 's1' });
		expect(v.allowed).toBe(true);
		expect(v.limits.effectivePerCallUsd).toBe(1);
		expect(v.limits.projectedSessionUsd).toBe(0.05);
	});

	it('refuses a hire above the hard per-call cap', () => {
		const v = evaluateSpendGuards({ priceUsd: 2, sessionId: 's1' });
		expect(v.allowed).toBe(false);
		expect(v.code).toBe('spend_cap_exceeded');
		expect(v.message).toContain('per-call cap');
	});

	it('lets a caller maxSpendUsd TIGHTEN the cap', () => {
		// $0.05 hire is fine normally, but a $0.02 caller budget refuses it.
		const v = evaluateSpendGuards({ priceUsd: 0.05, maxSpendUsd: 0.02, sessionId: 's1' });
		expect(v.allowed).toBe(false);
		expect(v.code).toBe('spend_cap_exceeded');
		expect(v.message).toContain('maxSpendUsd');
		expect(v.limits.effectivePerCallUsd).toBe(0.02);
	});

	it('NEVER lets a caller maxSpendUsd RAISE the hard cap', () => {
		// A caller asking for a $100 budget cannot push a $2 hire past the $1 cap.
		const v = evaluateSpendGuards({ priceUsd: 2, maxSpendUsd: 100, sessionId: 's1' });
		expect(v.allowed).toBe(false);
		expect(v.code).toBe('spend_cap_exceeded');
		// effective cap is the hard cap, not the inflated caller value.
		expect(v.limits.effectivePerCallUsd).toBe(1);
	});

	it('rejects a malformed / negative price (fails closed, not $0)', () => {
		for (const bad of [NaN, -1, Infinity]) {
			const v = evaluateSpendGuards({ priceUsd: bad, sessionId: 's1' });
			expect(v.allowed).toBe(false);
			expect(v.code).toBe('invalid_price');
		}
	});
});

describe('evaluateSpendGuards — confirmation threshold', () => {
	it('requires confirm:true at or above the threshold', () => {
		const v = evaluateSpendGuards({ priceUsd: 0.5, sessionId: 's1' });
		expect(v.allowed).toBe(false);
		expect(v.code).toBe('confirmation_required');
		expect(v.message).toContain('confirm: true');
	});

	it('passes an over-threshold hire once confirmed', () => {
		const v = evaluateSpendGuards({ priceUsd: 0.5, confirm: true, sessionId: 's1' });
		expect(v.allowed).toBe(true);
	});

	it('does not require confirmation below the threshold', () => {
		const v = evaluateSpendGuards({ priceUsd: 0.49, sessionId: 's1' });
		expect(v.allowed).toBe(true);
	});
});

describe('evaluateSpendGuards — per-session cap', () => {
	it('blocks the hire that would push cumulative spend over the session cap', () => {
		// Session cap is $5. Settle $4.90, then a $0.20 hire would reach $5.10.
		recordSessionSpend('runaway', 4.9);
		const v = evaluateSpendGuards({ priceUsd: 0.2, sessionId: 'runaway' });
		expect(v.allowed).toBe(false);
		expect(v.code).toBe('session_cap_exceeded');
		expect(v.limits.sessionSpentUsd).toBe(4.9);
		expect(v.limits.projectedSessionUsd).toBeCloseTo(5.1, 6);
	});

	it('allows a hire that lands exactly on the session cap', () => {
		recordSessionSpend('exact', 4.95);
		const v = evaluateSpendGuards({ priceUsd: 0.05, sessionId: 'exact' });
		expect(v.allowed).toBe(true);
		expect(v.limits.projectedSessionUsd).toBeCloseTo(5, 6);
	});

	it('scopes the cap per session id (one runaway session never starves another)', () => {
		recordSessionSpend('a', 4.99);
		expect(evaluateSpendGuards({ priceUsd: 0.05, sessionId: 'a' }).allowed).toBe(false);
		// A different session is unaffected.
		expect(evaluateSpendGuards({ priceUsd: 0.05, sessionId: 'b' }).allowed).toBe(true);
	});
});

describe('evaluateSpendGuards — purity', () => {
	it('NEVER mutates the session ledger (evaluation is read-only)', () => {
		expect(getSessionSpend('pure')).toBe(0);
		evaluateSpendGuards({ priceUsd: 0.05, sessionId: 'pure' });
		evaluateSpendGuards({ priceUsd: 0.05, sessionId: 'pure' });
		// Only recordSessionSpend moves the ledger.
		expect(getSessionSpend('pure')).toBe(0);
	});
});

describe('session ledger', () => {
	it('accumulates settled spend and retains provenance history', () => {
		const p1 = { agentName: 'A', payment: { amountUsd: 0.05 } };
		const p2 = { agentName: 'B', payment: { amountUsd: 0.05 } };
		expect(recordSessionSpend('led', 0.05, p1)).toBeCloseTo(0.05, 6);
		expect(recordSessionSpend('led', 0.05, p2)).toBeCloseTo(0.1, 6);
		expect(getSessionSpend('led')).toBeCloseTo(0.1, 6);
		const hires = getSessionHires('led');
		expect(hires).toHaveLength(2);
		expect(hires[0].agentName).toBe('A');
		expect(hires[1].agentName).toBe('B');
	});

	it('ignores a non-positive / malformed recorded amount', () => {
		recordSessionSpend('z', -1);
		recordSessionSpend('z', NaN);
		recordSessionSpend('z', 'junk');
		expect(getSessionSpend('z')).toBe(0);
	});

	it('treats blank/absent session id as the default connection session', () => {
		recordSessionSpend(undefined, 0.05);
		expect(getSessionSpend('   ')).toBeCloseTo(0.05, 6);
		expect(getSessionSpend('default')).toBeCloseTo(0.05, 6);
	});
});

// ---------------------------------------------------------------------------
// Provenance receipt shape — trust through visibility
// ---------------------------------------------------------------------------

describe('buildProvenance — receipt shape', () => {
	const base = {
		agentId: '5a4b3c2d-1234-5678-90ab-cdef01234567',
		agentName: 'Pump Sage',
		reputation: { average: 0.94, count: 12, source: 'erc8004', chain: 'Base', erc8004AgentId: '7' },
		capabilityMatch: 0.753,
		amountUsd: 0.05,
		latencyMs: 1840,
		model: 'claude-haiku-4-5-20251001',
		payTo: 'THREEsynthetic1111111111111111111111111PayTo',
		task: 'Summarise the latest pump.fun graduations in 3 bullets.',
	};

	it('emits the documented top-level shape', () => {
		const p = buildProvenance(base);
		expect(p).toMatchObject({
			agentId: base.agentId,
			agentName: 'Pump Sage',
			capabilityMatch: 0.75, // rounded to 2dp
			model: 'claude-haiku-4-5-20251001',
			latencyMs: 1840,
		});
		expect(typeof p.settledAt).toBe('string');
		expect(() => new Date(p.settledAt).toISOString()).not.toThrow();
	});

	it('names USDC on Solana mainnet as the settlement rail', () => {
		const p = buildProvenance(base);
		expect(p.payment.asset).toBe(SETTLEMENT_ASSET);
		expect(p.payment.asset).toBe('USDC');
		expect(p.payment.network).toBe(SETTLEMENT_NETWORK);
		expect(p.payment.networkLabel).toBe('Solana mainnet');
		expect(p.payment.scheme).toBe('exact');
		expect(p.payment.amountDisplay).toBe('$0.05');
		expect(p.payment.amountUsd).toBe(0.05);
		expect(p.payment.payTo).toBe(base.payTo);
	});

	it('NEVER inlines a fabricated tx signature — points to _meta for the real one', () => {
		const p = buildProvenance(base);
		expect(p.payment.settlementRef).toBe('see _meta["x402/payment-response"]');
		// A base58 Solana signature is 64+ chars; assert nothing like one leaked
		// into the provenance block (the real ref is attached by the x402 wrapper).
		const blob = JSON.stringify(p);
		expect(/[1-9A-HJ-NP-Za-km-z]{64,}/.test(blob)).toBe(false);
	});

	it('maps reputation when present and nulls it when absent', () => {
		const withRep = buildProvenance(base);
		expect(withRep.reputation).toMatchObject({
			average: 0.94,
			count: 12,
			source: 'erc8004',
			chain: 'Base',
			erc8004AgentId: '7',
		});
		const noRep = buildProvenance({ ...base, reputation: null });
		expect(noRep.reputation).toBeNull();
	});

	it('truncates an over-long task to 280 chars', () => {
		const p = buildProvenance({ ...base, task: 'x'.repeat(500) });
		expect(p.task.length).toBe(280);
	});

	it('rounds the settled amount to USDC (6dp) precision', () => {
		const p = buildProvenance({ ...base, amountUsd: 0.0500009 });
		expect(p.payment.amountUsd).toBe(0.050001);
	});

	it('tolerates missing optional fields without throwing', () => {
		const p = buildProvenance({ agentId: 'x', amountUsd: 0.05, latencyMs: 100 });
		expect(p.agentName).toBeNull();
		expect(p.reputation).toBeNull();
		expect(p.capabilityMatch).toBeNull();
		expect(p.model).toBeNull();
		expect(p.payment.payTo).toBeNull();
	});
});

describe('coin policy — receipts settle in USDC and promote no other token', () => {
	it('a provenance receipt references only USDC as money, no other coin', () => {
		const p = buildProvenance({
			agentId: 'x',
			agentName: 'A',
			amountUsd: 0.05,
			latencyMs: 100,
			task: 'do a thing',
		});
		const blob = JSON.stringify(p).toLowerCase();
		// USDC is the only money token named; assert no rival token tickers leak in.
		expect(blob).toContain('usdc');
		for (const forbidden of ['sol ', 'wsol', 'bonk', 'wif', 'usdt', 'dai']) {
			expect(blob.includes(forbidden)).toBe(false);
		}
	});
});
