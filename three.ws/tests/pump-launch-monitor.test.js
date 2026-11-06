import { describe, it, expect } from 'vitest';
import { classifyLaunchMonitor } from '../api/_lib/x402/pump-launch-monitor.js';

// Simulate a real list-mode /api/x402/pump-agent-audit response.
function makeResponse({ launches = [], overrides = {} } = {}) {
	const liq = launches.map((l) => l.liquidity_sol).filter((v) => v != null && v > 0);
	const avg = liq.length ? liq.reduce((a, b) => a + b, 0) / liq.length : null;
	const max = liq.length ? Math.max(...liq) : null;
	return {
		network: 'mainnet',
		sort: 'newest',
		count: launches.length,
		newest_mint: launches[0]?.mint || null,
		newest_name: launches[0]?.name || null,
		newest_symbol: launches[0]?.symbol || null,
		avg_initial_liquidity_sol: avg,
		max_initial_liquidity_sol: max,
		launches,
		queried_at: '2026-06-28T00:00:00Z',
		...overrides,
	};
}

const LAUNCHES = [
	{ mint: 'AAA1111111111111111111111111111111111111111', name: 'Pepe', symbol: 'PEPE', liquidity_sol: 30, is_agent_token: false },
	{ mint: 'BBB2222222222222222222222222222222222222222', name: 'Moo', symbol: 'MOO', liquidity_sol: 10, is_agent_token: true },
	{ mint: 'CCC3333333333333333333333333333333333333333', name: 'Ape', symbol: 'APE', liquidity_sol: null, is_agent_token: false },
];

describe('classifyLaunchMonitor', () => {
	it('extracts core signal fields from a full response', () => {
		const r = makeResponse({ launches: LAUNCHES });
		const s = classifyLaunchMonitor(r);
		expect(s.count).toBe(3);
		expect(s.newest_mint).toBe('AAA1111111111111111111111111111111111111111');
		expect(s.newest_name).toBe('Pepe');
		expect(s.newest_symbol).toBe('PEPE');
	});

	it('computes avg_initial_liquidity from launches when endpoint pre-computation is absent', () => {
		// Override with null so classifyLaunchMonitor must recompute from launches array
		const r = makeResponse({ launches: LAUNCHES, overrides: { avg_initial_liquidity_sol: null } });
		const s = classifyLaunchMonitor(r);
		// Only the two non-null liquidity values (30 + 10) contribute
		expect(s.avg_initial_liquidity).toBeCloseTo(20, 5);
		expect(s.max_initial_liquidity).toBe(30);
	});

	it('prefers endpoint-pre-computed avg over local recompute when present', () => {
		const r = makeResponse({ launches: LAUNCHES, overrides: { avg_initial_liquidity_sol: 99.5 } });
		const s = classifyLaunchMonitor(r);
		expect(s.avg_initial_liquidity).toBe(99.5);
	});

	it('counts agent tokens correctly', () => {
		const s = classifyLaunchMonitor(makeResponse({ launches: LAUNCHES }));
		expect(s.agent_token_count).toBe(1);
	});

	it('handles empty launches gracefully', () => {
		const s = classifyLaunchMonitor(makeResponse({ launches: [] }));
		expect(s.count).toBe(0);
		expect(s.newest_mint).toBeNull();
		expect(s.avg_initial_liquidity).toBeNull();
		expect(s.max_initial_liquidity).toBeNull();
		expect(s.agent_token_count).toBe(0);
	});

	it('handles null/missing response without throwing', () => {
		expect(() => classifyLaunchMonitor(null)).not.toThrow();
		expect(() => classifyLaunchMonitor(undefined)).not.toThrow();
		const s = classifyLaunchMonitor(null);
		expect(s.count).toBe(0);
	});

	it('treats launches with liquidity_sol=0 as having no liquidity', () => {
		const launches = [
			{ mint: 'A'.repeat(44), name: 'Z', symbol: 'ZZ', liquidity_sol: 0, is_agent_token: false },
		];
		const s = classifyLaunchMonitor(makeResponse({ launches }));
		// 0 is filtered from the liq array → avg and max stay null
		expect(s.avg_initial_liquidity).toBeNull();
		expect(s.max_initial_liquidity).toBeNull();
	});
});
