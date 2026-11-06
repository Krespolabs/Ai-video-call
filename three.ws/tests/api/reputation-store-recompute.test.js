// Regression test for the recompute-reputation cron 504.
//
// The cron 504'd at Vercel's 300s hard kill even though it passed a 250s deadline:
// the deadline was only checked BETWEEN chunks, so one un-timed getAgentReputation()
// (a stalled Solana RPC / slow DB read) inside Promise.allSettled blocked the whole
// batch past the timeout. recomputeAgents now bounds each agent with a per-agent
// timeout capped at the wall-clock remaining before the deadline, so a hung upstream
// can never run the batch past its budget. These tests lock that in with a fake
// getAgentReputation that hangs forever.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// sql is used as a tagged template; a plain async fn resolving to [] satisfies
// ensureTable() (returns true) and saveReputation()'s upsert (no throw → true).
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getAgentReputation = vi.fn();
vi.mock('../../api/_lib/trust/wallet-reputation.js', () => ({
	getAgentReputation: (...args) => getAgentReputation(...args),
	REPUTATION_VERSION: 3,
}));

const { recomputeAgents } = await import('../../api/_lib/trust/reputation-store.js');

const okResult = (id) => ({
	agent_id: id,
	score: 50,
	tier: 'silver',
	isNew: false,
	version: 3,
	partial: false,
});

beforeEach(() => {
	getAgentReputation.mockReset();
});

describe('recomputeAgents — per-agent timeout guards the cron budget', () => {
	it('does not block on a single hung agent; bounds it and scores the rest', async () => {
		getAgentReputation.mockImplementation((id) =>
			id === 'hang' ? new Promise(() => {}) : Promise.resolve(okResult(id)),
		);
		const started = Date.now();
		const res = await recomputeAgents(['a', 'hang', 'b'], {
			concurrency: 1,
			deadlineMs: 5_000,
			perAgentTimeoutMs: 50,
		});
		const elapsed = Date.now() - started;
		// The hung agent alone would have run past any timeout; a bounded run returns
		// in well under a second, proving the per-agent cap fired.
		expect(elapsed).toBeLessThan(1_000);
		expect(res.scored).toBe(2); // a + b
		expect(res.failed).toBe(1); // hung agent → timed out → failed
		expect(res.remaining).toBe(0);
	});

	it('stops within the deadline when every agent hangs (never 504s)', async () => {
		getAgentReputation.mockImplementation(() => new Promise(() => {}));
		const ids = Array.from({ length: 20 }, (_, i) => `agent-${i}`);
		const started = Date.now();
		const res = await recomputeAgents(ids, {
			concurrency: 2,
			deadlineMs: 120,
			perAgentTimeoutMs: 40,
		});
		const elapsed = Date.now() - started;
		// Bounded by the deadline (+ at most one perAgentTimeoutMs), not infinite.
		expect(elapsed).toBeLessThan(1_500);
		expect(res.timedOut).toBe(true);
		expect(res.scored).toBe(0);
		expect(res.remaining).toBeGreaterThan(0); // unfinished agents roll over
	});

	it('never overruns the deadline by more than one per-agent budget', async () => {
		// A slow-but-finite agent (200ms) with a 40ms cap must be cut off at ~40ms,
		// not waited out — otherwise 20 of them would blow a 120ms deadline wide open.
		getAgentReputation.mockImplementation(
			(id) => new Promise((resolve) => setTimeout(() => resolve(okResult(id)), 200)),
		);
		const ids = Array.from({ length: 20 }, (_, i) => `slow-${i}`);
		const started = Date.now();
		const res = await recomputeAgents(ids, {
			concurrency: 4,
			deadlineMs: 150,
			perAgentTimeoutMs: 40,
		});
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(150 + 200); // deadline + one over-budget chunk max
		expect(res.timedOut).toBe(true);
	});
});
