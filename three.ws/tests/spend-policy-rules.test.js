/**
 * Natural-language spend policies — the deterministic core, pinned.
 *
 * This is money governance: the LLM only authors these rules, but THIS evaluator
 * enforces them on every spend. So the invariants that keep it trustworthy are
 * tested here, with no model and no DB (everything is pure):
 *   - normalization is TOTAL — malformed/hostile input never throws, it drops away,
 *   - the evaluator is first-match and fails closed on unobservable signals (a
 *     token-age rule is inert on an x402 payment, never a false block),
 *   - the plain-English readback is generated from the DSL (golden-pinned) so it can
 *     never drift from what code enforces,
 *   - the backtest math (rolling daily window, allowed/blocked tallies) is faithful,
 *   - a policy diff flags any loosening so protection is never weakened silently.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizePolicyRules, evaluatePolicy, isDenied, describeRule, describePolicyRules,
	diffPolicies, backtestPolicy, syntheticProbes, referencedFields,
	MAX_RULES, MAX_CLAUSES_PER_RULE,
} from '../api/_lib/spend-policy-rules.js';

const block = (when) => ({ action: 'block', when });
const evalDoc = (rules, ctx) => evaluatePolicy(normalizePolicyRules({ rules }), ctx);

describe('normalizePolicyRules — totality', () => {
	it('never throws on hostile / malformed input', () => {
		for (const bad of [null, undefined, 42, 'x', [], {}, { rules: 'no' }, { rules: [null, 1, {}] }, { rules: [{ action: 'nuke', when: [] }] }]) {
			expect(() => normalizePolicyRules(bad)).not.toThrow();
			expect(normalizePolicyRules(bad).rules).toBeInstanceOf(Array);
		}
	});

	it('drops rules whose every clause is invalid (no silent block-all)', () => {
		const doc = normalizePolicyRules({ rules: [{ action: 'block', when: [{ field: 'nonsense', op: 'gt', value: 1 }] }] });
		expect(doc.rules).toHaveLength(0);
	});

	it('drops empty-when rules — a catch-all belongs to the freeze switch', () => {
		expect(normalizePolicyRules({ rules: [{ action: 'block', when: [] }] }).rules).toHaveLength(0);
	});

	it('rejects an illegal operator for a field type', () => {
		// 'in' is a string op; illegal on a numeric field → clause dropped → rule dropped.
		expect(normalizePolicyRules({ rules: [block([{ field: 'amount_usd', op: 'in', value: [1, 2] }])] }).rules).toHaveLength(0);
		// boolean field only accepts 'is'
		expect(normalizePolicyRules({ rules: [block([{ field: 'destination_allowlisted', op: 'gt', value: 1 }])] }).rules).toHaveLength(0);
	});

	it('caps rule count and clause count', () => {
		const many = Array.from({ length: MAX_RULES + 20 }, () => block([{ field: 'amount_usd', op: 'gt', value: 1 }]));
		expect(normalizePolicyRules({ rules: many }).rules.length).toBeLessThanOrEqual(MAX_RULES);

		const manyClauses = Array.from({ length: MAX_CLAUSES_PER_RULE + 5 }, (_, i) => ({ field: 'amount_usd', op: 'gt', value: i }));
		const doc = normalizePolicyRules({ rules: [block(manyClauses)] });
		expect(doc.rules[0].when.length).toBeLessThanOrEqual(MAX_CLAUSES_PER_RULE);
	});

	it('assigns unique ids', () => {
		const doc = normalizePolicyRules({ rules: [
			{ id: 'r', action: 'block', when: [{ field: 'amount_usd', op: 'gt', value: 1 }] },
			{ id: 'r', action: 'block', when: [{ field: 'amount_usd', op: 'gt', value: 2 }] },
		] });
		expect(new Set(doc.rules.map((r) => r.id)).size).toBe(doc.rules.length);
	});

	it('coerces numeric/boolean string values', () => {
		const doc = normalizePolicyRules({ rules: [
			block([{ field: 'amount_usd', op: 'gt', value: '50' }]),
			block([{ field: 'counterparty_seen_before', op: 'is', value: 'false' }]),
		] });
		expect(doc.rules[0].when[0].value).toBe(50);
		expect(doc.rules[1].when[0].value).toBe(false);
	});
});

describe('evaluatePolicy — decisions', () => {
	it('blocks an over-limit amount, allows under', () => {
		const rules = [block([{ field: 'amount_usd', op: 'gt', value: 50 }])];
		expect(evalDoc(rules, { amount_usd: 60 }).decision).toBe('block');
		expect(evalDoc(rules, { amount_usd: 40 }).decision).toBe('allow');
	});

	it('defaults to allow when nothing matches', () => {
		expect(evalDoc([block([{ field: 'amount_usd', op: 'gt', value: 50 }])], { amount_usd: 1 }).matched).toBeNull();
	});

	it('an unobservable signal never matches (token-age rule inert on x402)', () => {
		const rules = [block([{ field: 'category', op: 'eq', value: 'trade' }, { field: 'token_age_hours', op: 'lt', value: 24 }])];
		// x402 payment: no token_age in context → rule cannot fire.
		expect(evalDoc(rules, { category: 'x402', amount_usd: 5 }).decision).toBe('allow');
		// young-token trade → blocked.
		expect(evalDoc(rules, { category: 'trade', token_age_hours: 2 }).decision).toBe('block');
		// old-token trade → allowed.
		expect(evalDoc(rules, { category: 'trade', token_age_hours: 100 }).decision).toBe('allow');
	});

	it('first match wins — an allow carve-out short-circuits a later block', () => {
		const rules = [
			{ action: 'allow', when: [{ field: 'counterparty', op: 'eq', value: 'TRUSTED' }] },
			block([{ field: 'amount_usd', op: 'gt', value: 10 }]),
		];
		expect(evalDoc(rules, { counterparty: 'TRUSTED', amount_usd: 999 }).decision).toBe('allow');
		expect(evalDoc(rules, { counterparty: 'OTHER', amount_usd: 999 }).decision).toBe('block');
	});

	it('freeze and require_step_up are denials', () => {
		expect(isDenied(evalDoc([{ action: 'freeze', when: [{ field: 'trade_pnl_pct', op: 'lt', value: -30 }] }], { trade_pnl_pct: -50 }).decision)).toBe(true);
		expect(evalDoc([{ action: 'require_step_up', when: [{ field: 'amount_usd', op: 'gt', value: 100 }] }], { amount_usd: 200 }).decision).toBe('step_up');
	});

	it('sol_reserve_after floor blocks draining the last SOL', () => {
		const rules = [block([{ field: 'sol_reserve_after', op: 'lt', value: 1 }])];
		expect(evalDoc(rules, { sol_reserve_after: 0.4 }).decision).toBe('block');
		expect(evalDoc(rules, { sol_reserve_after: 5 }).decision).toBe('allow');
	});

	it('counterparty_seen_before=false blocks first-time payees', () => {
		const rules = [block([{ field: 'category', op: 'eq', value: 'x402' }, { field: 'counterparty_seen_before', op: 'is', value: false }])];
		expect(evalDoc(rules, { category: 'x402', counterparty_seen_before: false }).decision).toBe('block');
		expect(evalDoc(rules, { category: 'x402', counterparty_seen_before: true }).decision).toBe('allow');
	});

	it('is total — a corrupt rule object never throws', () => {
		const doc = { rules: [{ action: 'block', when: [{ field: 'amount_usd', op: 'gt', value: 'NaN-ish' }] }, null, { when: null }] };
		expect(() => evaluatePolicy(doc, { amount_usd: 5 })).not.toThrow();
	});
});

describe('describeRule / readback — golden (must match enforcement)', () => {
	it('renders the README worked example, rule by rule', () => {
		expect(describeRule(block([{ field: 'amount_usd', op: 'gt', value: 50 }])))
			.toBe('Block the spend when the amount is over $50.');
		expect(describeRule(block([{ field: 'sol_reserve_after', op: 'lt', value: 1 }])))
			.toBe('Block the spend when it would leave less than 1 SOL in the wallet.');
		expect(describeRule({ action: 'freeze', when: [{ field: 'trade_pnl_pct', op: 'lt', value: -30 }] }))
			.toBe('Freeze the wallet and block all spending when the trade is down more than 30%.');
		expect(describeRule(block([{ field: 'category', op: 'eq', value: 'x402' }, { field: 'counterparty_seen_before', op: 'is', value: false }])))
			.toBe('Block the spend when it is an x402 payment and you have never paid this recipient before.');
		expect(describeRule(block([{ field: 'category', op: 'eq', value: 'trade' }, { field: 'token_age_hours', op: 'lt', value: 24 }])))
			.toBe('Block the spend when it is a trade and the token is younger than 1 day.');
	});

	it('numbers the policy readback', () => {
		const rb = describePolicyRules(normalizePolicyRules({ rules: [
			block([{ field: 'amount_usd', op: 'gt', value: 50 }]),
			block([{ field: 'sol_reserve_after', op: 'lt', value: 1 }]),
		] }));
		expect(rb.map((r) => r.n)).toEqual([1, 2]);
		expect(rb[0].text).toContain('over $50');
	});
});

describe('diffPolicies — loosening detection', () => {
	const a = normalizePolicyRules({ rules: [block([{ field: 'amount_usd', op: 'gt', value: 50 }])] });
	const tighter = normalizePolicyRules({ rules: [
		block([{ field: 'amount_usd', op: 'gt', value: 50 }]),
		block([{ field: 'sol_reserve_after', op: 'lt', value: 1 }]),
	] });
	const empty = normalizePolicyRules({ rules: [] });

	it('flags removing a protective rule as loosening', () => {
		expect(diffPolicies(a, empty).loosened).toBe(true);
		expect(diffPolicies(a, empty).loosening_notes.length).toBeGreaterThan(0);
	});
	it('adding a rule is not loosening', () => {
		const d = diffPolicies(a, tighter);
		expect(d.loosened).toBe(false);
		expect(d.added).toHaveLength(1);
	});
	it('an identical policy has no diff', () => {
		const d = diffPolicies(a, a);
		expect(d.added).toHaveLength(0);
		expect(d.removed).toHaveLength(0);
		expect(d.loosened).toBe(false);
	});
});

describe('backtestPolicy — faithful replay', () => {
	const day = (n) => new Date(Date.UTC(2026, 0, n, 12, 0, 0)).toISOString();
	const spend = (id, usd, extra = {}) => ({ id, event_type: 'spend', category: 'x402', asset: 'USDC', usd, created_at: day(id), ...extra });

	it('counts allowed vs blocked by the same evaluator', () => {
		const doc = normalizePolicyRules({ rules: [block([{ field: 'amount_usd', op: 'gt', value: 50 }])] });
		const events = [spend(1, 10), spend(2, 80), spend(3, 200), spend(4, 5)];
		const bt = backtestPolicy(doc, events);
		expect(bt.total).toBe(4);
		expect(bt.blocked).toBe(2);
		expect(bt.allowed).toBe(2);
		expect(bt.blocked_usd).toBe(280);
		expect(bt.by_rule[0].count).toBe(2);
	});

	it('rolling daily total only counts ALLOWED spends', () => {
		// "block when today's total would exceed $100". Replayed same-day.
		const doc = normalizePolicyRules({ rules: [block([{ field: 'daily_total_usd', op: 'gt', value: 100 }])] });
		const sameDay = (i, usd) => ({ id: i, event_type: 'spend', category: 'x402', asset: 'USDC', usd, created_at: new Date(Date.UTC(2026, 0, 1, 10 + i, 0, 0)).toISOString() });
		// 60 (ok, total 60) → 60 (blocked, would be 120) → 30 (ok, total 90; the blocked
		// one never counted) → 30 (blocked, would be 120).
		const bt = backtestPolicy(doc, [sameDay(1, 60), sameDay(2, 60), sameDay(3, 30), sameDay(4, 30)]);
		expect(bt.allowed).toBe(2);
		expect(bt.blocked).toBe(2);
	});

	it('ignores non-spend rows and is total on junk', () => {
		expect(() => backtestPolicy(normalizePolicyRules({ rules: [] }), null)).not.toThrow();
		const bt = backtestPolicy(normalizePolicyRules({ rules: [block([{ field: 'amount_usd', op: 'gt', value: 1 }])] }),
			[{ event_type: 'limit_change' }, { event_type: 'spend', usd: 5, created_at: day(1) }]);
		expect(bt.total).toBe(1);
	});
});

describe('syntheticProbes + referencedFields', () => {
	it('returns probes exercised by the same evaluator', () => {
		const doc = normalizePolicyRules({ rules: [block([{ field: 'amount_usd', op: 'gt', value: 50 }])] });
		const probes = syntheticProbes(doc);
		expect(probes.length).toBeGreaterThan(0);
		// A $250 payment must be flagged blocked.
		expect(probes.some((p) => p.denied)).toBe(true);
	});
	it('referencedFields reports the fields a policy reads', () => {
		const doc = normalizePolicyRules({ rules: [block([{ field: 'daily_total_usd', op: 'gt', value: 50 }])] });
		expect([...referencedFields(doc)]).toContain('daily_total_usd');
	});
});
