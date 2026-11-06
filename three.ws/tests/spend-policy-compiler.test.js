/**
 * Natural-language → spend-policy compiler — the deterministic parser path.
 *
 * The compiler prefers the platform LLM but degrades to a real intent parser, so
 * the feature compiles with no model configured. These tests exercise that parser
 * (no network) and assert the README's worked example maps to the exact enforceable
 * rules — the compiler must never silently produce nothing for a clear instruction,
 * and everything it emits is hard-validated by the same normalizer the engine uses.
 *
 * Assertions check rule SHAPE (action + clause), which both the parser and a
 * well-behaved model satisfy, so the suite is robust whether or not a key is set.
 */

import { describe, it, expect } from 'vitest';
import { compilePolicyFromText } from '../api/_lib/spend-policy-compiler.js';

// Find a rule containing a clause matching field (+optional op/value/action).
function hasRule(policy, { action, field, op, value } = {}) {
	return (policy?.rules || []).some((r) =>
		(action == null || r.action === action) &&
		(r.when || []).some((c) =>
			(field == null || c.field === field) &&
			(op == null || c.op === op) &&
			(value == null || c.value === value)));
}

describe('compilePolicyFromText — worked example', () => {
	it('compiles "block any payment over $50"', async () => {
		const r = await compilePolicyFromText('Block any payment over $50.');
		expect(r.ok).toBe(true);
		expect(hasRule(r.policy, { action: 'block', field: 'amount_usd', op: 'gt', value: 50 })).toBe(true);
		expect(Array.isArray(r.readback)).toBe(true);
		expect(r.readback.length).toBeGreaterThan(0);
	});

	it('compiles "up to $50 a day" to a daily-total block', async () => {
		const r = await compilePolicyFromText('Let it trade up to $50 a day.');
		expect(r.ok).toBe(true);
		expect(hasRule(r.policy, { action: 'block', field: 'daily_total_usd' })).toBe(true);
	});

	it('compiles "only trade tokens at least a day old"', async () => {
		const r = await compilePolicyFromText('Only trade tokens at least a day old.');
		expect(r.ok).toBe(true);
		expect(hasRule(r.policy, { action: 'block', field: 'token_age_hours', op: 'lt' })).toBe(true);
	});

	it('compiles "never spend my last 1 SOL"', async () => {
		const r = await compilePolicyFromText('Never spend my last 1 SOL.');
		expect(r.ok).toBe(true);
		expect(hasRule(r.policy, { action: 'block', field: 'sol_reserve_after', op: 'lt', value: 1 })).toBe(true);
	});

	it('compiles "stop everything if a trade drops more than 30%" to a freeze', async () => {
		const r = await compilePolicyFromText('Stop everything if a single trade drops more than 30%.');
		expect(r.ok).toBe(true);
		expect(hasRule(r.policy, { action: 'freeze', field: 'trade_pnl_pct', op: 'lt', value: -30 })).toBe(true);
	});

	it('compiles "only ever pay services I\'ve used before"', async () => {
		const r = await compilePolicyFromText("Only ever pay services I've used before.");
		expect(r.ok).toBe(true);
		expect(hasRule(r.policy, { action: 'block', field: 'counterparty_seen_before', op: 'is', value: false })).toBe(true);
	});

	it('compiles the full README sentence into multiple rules', async () => {
		const r = await compilePolicyFromText(
			'Let it trade up to $50/day on tokens at least a day old, never spend my last 1 SOL, stop everything if a single trade drops more than 30%, and only ever pay services I\'ve used before.',
		);
		expect(r.ok).toBe(true);
		expect(r.policy.rules.length).toBeGreaterThanOrEqual(3);
		expect(hasRule(r.policy, { field: 'sol_reserve_after' })).toBe(true);
		expect(hasRule(r.policy, { action: 'freeze' })).toBe(true);
	});
});

describe('compilePolicyFromText — refusal / empty', () => {
	it('refuses an empty input', async () => {
		const r = await compilePolicyFromText('   ');
		expect(r.ok).toBe(false);
		expect(r.error).toBe('empty');
	});

	it('reports unparseable rather than inventing a rule', async () => {
		const r = await compilePolicyFromText('the quick brown fox jumps over the lazy dog');
		// No concrete spend rule → not ok, with an actionable message.
		expect(r.ok).toBe(false);
		expect(typeof r.message).toBe('string');
	});

	it('every compiled rule is hard-validated (enforceable)', async () => {
		const r = await compilePolicyFromText('Block any payment over $5 and freeze if a trade drops 50%.');
		expect(r.ok).toBe(true);
		for (const rule of r.policy.rules) {
			expect(['allow', 'block', 'require_step_up', 'freeze']).toContain(rule.action);
			expect(rule.when.length).toBeGreaterThan(0);
		}
	});
});
