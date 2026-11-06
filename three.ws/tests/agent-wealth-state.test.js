// Unit tests for Embodied Finance — src/shared/agent-wealth-state.js.
//
// The wealth state is the DYNAMICS layer on top of the static net-worth aura:
// real 24h momentum, active money streams, and tip recency turned into a small,
// honest, DETERMINISTIC dynamics descriptor. These tests pin that contract —
// the neutral fallback, the normalize mapping from the server `flow` block, the
// momentum→trend/intensity/warmth mapping, the streaming + tip-recency flags
// (with `now` injected so there is no time flakiness), and the momentum label.
// No network: every input is a plain object.

import { describe, it, expect } from 'vitest';
import {
	computeWealthDynamics,
	formatMomentum,
	_internals,
} from '../src/shared/agent-wealth-state.js';

const { normalizeWealth, neutralState, RECENT_TIP_MS } = _internals;

describe('neutralState', () => {
	it('is a coherent, honest dormant baseline (never a fake glow)', () => {
		const s = neutralState('a1', 'mainnet');
		expect(s.tier).toBe('dormant');
		expect(s.level).toBe(0);
		expect(s.balanceSol).toBe(0);
		expect(s.balanceUsd).toBe(0);
		expect(s.momentum).toBe(0);
		expect(s.streamingNow).toBe(0);
		expect(s.lastTipAt).toBeNull();
		expect(s.ok).toBe(false);
	});
});

describe('normalizeWealth', () => {
	it('maps the server flow block onto the canonical wealth state', () => {
		const data = {
			tier: { key: 'glow', label: 'Glow', index: 3 },
			is_owner: true,
			portfolio: { usd: 420, sol: 2.1 },
			flow: {
				balance_usd: 420, balance_sol: 2.1, tier: 'glow',
				momentum: 0.6, momentum_usd_24h: 80, inflow_usd_24h: 100, outflow_usd_24h: 20,
				streaming_now: 2, last_tip_at: '2026-06-23T00:00:00.000Z',
			},
		};
		const s = normalizeWealth('a1', 'mainnet', data, data.flow);
		expect(s.tier).toBe('glow');
		expect(s.level).toBe(3);
		expect(s.balanceUsd).toBe(420);
		expect(s.balanceSol).toBe(2.1);
		expect(s.momentum).toBe(0.6);
		expect(s.momentumUsd24h).toBe(80);
		expect(s.streamingNow).toBe(2);
		expect(s.lastTipAt).toBe('2026-06-23T00:00:00.000Z');
		expect(s.isOwner).toBe(true);
		expect(s.ok).toBe(true);
	});

	it('clamps momentum into [-1,1] and floors streaming at 0', () => {
		const flow = { balance_usd: 0, momentum: 5, streaming_now: -3 };
		const s = normalizeWealth('a1', 'mainnet', { flow }, flow);
		expect(s.momentum).toBe(1);
		expect(s.streamingNow).toBe(0);
	});

	it('derives the tier from balance when the server omits a tier object', () => {
		const flow = { balance_usd: 30000 }; // ≥ $25k → luminous
		const s = normalizeWealth('a1', 'mainnet', { flow }, flow);
		expect(s.tier).toBe('luminous');
		expect(s.level).toBe(5);
	});
});

describe('computeWealthDynamics', () => {
	const base = { momentum: 0, streamingNow: 0, lastTipAt: null };

	it('a flat wallet reads neutral — no trend, no boost, no warmth', () => {
		const d = computeWealthDynamics({ ...base });
		expect(d.trend).toBe('flat');
		expect(d.intensityDelta).toBe(0);
		expect(d.warmth).toBe(0);
		expect(d.streaming).toBe(false);
		expect(d.recentTip).toBe(false);
	});

	it('positive momentum warms + lifts intensity; negative cools + dims', () => {
		const up = computeWealthDynamics({ ...base, momentum: 0.5 });
		expect(up.trend).toBe('up');
		expect(up.warmth).toBe(0.5);
		expect(up.intensityDelta).toBeGreaterThan(0);

		const down = computeWealthDynamics({ ...base, momentum: -0.5 });
		expect(down.trend).toBe('down');
		expect(down.warmth).toBe(-0.5);
		expect(down.intensityDelta).toBeLessThan(0);
	});

	it('intensity delta stays inside a tasteful band (never overpowers the tier)', () => {
		expect(Math.abs(computeWealthDynamics({ ...base, momentum: 1 }).intensityDelta)).toBeLessThanOrEqual(0.16);
		expect(Math.abs(computeWealthDynamics({ ...base, momentum: -1 }).intensityDelta)).toBeLessThanOrEqual(0.16);
	});

	it('streaming flips on only when a real stream is open', () => {
		expect(computeWealthDynamics({ ...base, streamingNow: 0 }).streaming).toBe(false);
		const d = computeWealthDynamics({ ...base, streamingNow: 3 });
		expect(d.streaming).toBe(true);
		expect(d.streamingCount).toBe(3);
	});

	it('a tip is "recent" only within the recency window (now injected)', () => {
		const now = 1_000_000_000_000;
		const fresh = new Date(now - 30_000).toISOString();
		const stale = new Date(now - RECENT_TIP_MS - 1_000).toISOString();
		expect(computeWealthDynamics({ ...base, lastTipAt: fresh }, now).recentTip).toBe(true);
		expect(computeWealthDynamics({ ...base, lastTipAt: stale }, now).recentTip).toBe(false);
	});

	it('is deterministic — same (state, now) yields the same dynamics', () => {
		const st = { momentum: 0.33, streamingNow: 1, lastTipAt: new Date(500).toISOString() };
		expect(computeWealthDynamics(st, 1000)).toEqual(computeWealthDynamics(st, 1000));
	});
});

describe('formatMomentum', () => {
	it('renders signed, compact, honest figures (— when flat)', () => {
		expect(formatMomentum({ momentumUsd24h: 0 })).toBe('—');
		expect(formatMomentum({ momentumUsd24h: 12 })).toBe('+$12 today');
		expect(formatMomentum({ momentumUsd24h: -4 })).toBe('−$4 today');
		expect(formatMomentum({ momentumUsd24h: 2500 })).toBe('+$2.5k today');
		expect(formatMomentum({ momentumUsd24h: 0.5 })).toBe('+$0.50 today');
	});
});
