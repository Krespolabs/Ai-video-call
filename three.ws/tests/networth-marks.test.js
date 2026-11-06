// Reputation regalia marks — the legible, ownable proof that the net-worth-reactive
// avatar's look is earned from REAL numbers (lifetime tips + realized P&L), not
// decoration. computeMarks is a pure function, so we can assert the exact contract
// the presence panel renders from.

import { describe, it, expect } from 'vitest';
import { computeMarks } from '../api/_lib/networth-model.js';

const HUB = '/agent/abc/wallet';
const byKey = (marks, key) => marks.find((m) => m.key === key);

describe('computeMarks — earned reputation regalia', () => {
	it('emits no tip/pnl marks for a fresh agent with no reputation', () => {
		const marks = computeMarks({ usd: 0 }, { hubUrl: HUB });
		expect(byKey(marks, 'tips')).toBeUndefined();
		expect(byKey(marks, 'pnl')).toBeUndefined();
	});

	it('surfaces lifetime tips with real USD volume, deep-linked to the hub', () => {
		const marks = computeMarks({ usd: 120, tipCount: 7, tipUsd: 42.5 }, { hubUrl: HUB });
		const tip = byKey(marks, 'tips');
		expect(tip).toBeTruthy();
		expect(tip.label).toContain('Tipped');
		expect(tip.detail).toContain('7 lifetime tips');
		expect(tip.href).toBe(HUB);
	});

	it('counts tips even when none were priceable (no USD)', () => {
		const tip = byKey(computeMarks({ tipCount: 3, tipUsd: 0 }, { hubUrl: HUB }), 'tips');
		expect(tip).toBeTruthy();
		expect(tip.value).toBe(3);
		expect(tip.label).toBe('Tipped 3×');
	});

	it('uses singular copy for a single tip', () => {
		const tip = byKey(computeMarks({ tipCount: 1, tipUsd: 0 }, { hubUrl: HUB }), 'tips');
		expect(tip.label).toBe('Tipped once');
		expect(tip.detail).toBe('1 lifetime tip');
	});

	it('shows realized P&L only when net-positive (never a scarlet letter)', () => {
		expect(byKey(computeMarks({ realizedPnlSol: -2.5, realizedWins: 0 }, { hubUrl: HUB }), 'pnl')).toBeUndefined();
		expect(byKey(computeMarks({ realizedPnlSol: 0, realizedWins: 0 }, { hubUrl: HUB }), 'pnl')).toBeUndefined();
		const pnl = byKey(computeMarks({ realizedPnlSol: 1.234, realizedWins: 4 }, { hubUrl: HUB }), 'pnl');
		expect(pnl).toBeTruthy();
		expect(pnl.label).toContain('SOL P&L');
		expect(pnl.detail).toContain('4 closed trades');
	});

	it('orders regalia after wealth/forks and keeps every mark hub-linked', () => {
		const marks = computeMarks(
			{ usd: 5000, threeAmount: 1000, threeUsd: 50, forkCount: 3, tipCount: 9, tipUsd: 88, realizedPnlSol: 0.5, realizedWins: 2 },
			{ hubUrl: HUB },
		);
		const keys = marks.map((m) => m.key);
		expect(keys).toEqual(['presence', 'three', 'forks', 'tips', 'pnl']);
		for (const m of marks) expect(m.href).toBe(HUB);
	});
});
