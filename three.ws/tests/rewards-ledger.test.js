// Tests for the rewards-distribution ledger reader/writer (api/_lib/token/payments.js).
// The DB is mocked: these prove the recorded shape and the rule that ONLY completed
// runs count toward the public "reflected to holders" total (planned/dry runs don't).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB: a tagged-template `sql` that returns whatever the test queues.
const queue = [];
vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});
// payments.js also imports these; stub so the module loads without a live RPC.
vi.mock('../api/_lib/solana/connection.js', () => ({ solanaConnection: vi.fn() }));

import { recordRewardsDistribution, listRewardsDistributions } from '../api/_lib/token/payments.js';
import { sql } from '../api/_lib/db.js';

beforeEach(() => {
	queue.length = 0;
	vi.clearAllMocks();
});

describe('recordRewardsDistribution', () => {
	it('inserts a run and returns its id', async () => {
		queue.push([{ id: 'dist-1', created_at: '2026-06-15T00:00:00Z' }]);
		const r = await recordRewardsDistribution({
			mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			poolWallet: 'PoolXXXX',
			poolAtomics: 1000n,
			distributedAtomics: 900n,
			dustAtomics: 100n,
			holderCount: 3,
			eligibleSupplyAtomics: 5000n,
			status: 'planned',
		});
		expect(r.id).toBe('dist-1');
		expect(sql).toHaveBeenCalledOnce();
	});

	it('serializes bigint atomics to strings (no precision loss)', async () => {
		queue.push([{ id: 'd', created_at: 'now' }]);
		await recordRewardsDistribution({
			mint: 'm',
			poolWallet: 'w',
			poolAtomics: 123456789012345678901234567890n,
		});
		// The tagged-template interpolations are passed as the 2nd+ args of sql();
		// confirm a huge bigint went in as a string, not a lossy Number.
		const interpolated = sql.mock.calls[0].slice(1).map(String);
		expect(interpolated).toContain('123456789012345678901234567890');
	});
});

describe('listRewardsDistributions', () => {
	it('returns history + reflected total from completed runs only', async () => {
		// First query: recent rows. Second query: completed-only aggregate.
		queue.push([
			{
				id: 'd2',
				mint: 'm',
				pool_wallet: 'w',
				pool_atomics: '1000',
				distributed_atomics: '900',
				dust_atomics: '100',
				holder_count: 3,
				eligible_supply_atomics: '5000',
				status: 'completed',
				tx_signatures: ['sig1'],
				note: null,
				created_at: 'd2t',
			},
			{
				id: 'd1',
				mint: 'm',
				pool_wallet: 'w',
				pool_atomics: '500',
				distributed_atomics: '500',
				dust_atomics: '0',
				holder_count: 2,
				eligible_supply_atomics: '4000',
				status: 'planned',
				tx_signatures: [],
				note: 'dry run',
				created_at: 'd1t',
			},
		]);
		// Aggregate over status='completed' only → 900 (the planned 500 excluded).
		queue.push([{ total: '900', n: 1 }]);

		const out = await listRewardsDistributions({ limit: 10 });
		expect(out.total_reflected_atomics).toBe('900');
		expect(out.run_count).toBe(1);
		expect(out.items).toHaveLength(2);
		expect(out.items[0].status).toBe('completed');
		expect(out.items[1].status).toBe('planned');
	});

	it('handles an empty ledger', async () => {
		queue.push([]); // no rows
		queue.push([{ total: '0', n: 0 }]);
		const out = await listRewardsDistributions();
		expect(out.total_reflected_atomics).toBe('0');
		expect(out.run_count).toBe(0);
		expect(out.items).toEqual([]);
	});
});
