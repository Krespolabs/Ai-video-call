// Unit tests for the $THREE holder snapshot cache (api/_lib/coin/three-holders.js).
// The DB (sql) and the live Helius scan (fetchHolderBalances) are mocked at the
// module boundary, so these exercise the staleness gate and the cold-cache
// fallback — the logic that decides whether a public read costs a DB query or a
// Helius DAS walk.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = { sql: vi.fn() };
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => h.sql(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/coin/holders.js', () => ({ fetchHolderBalances: vi.fn() }));
vi.mock('../../api/_lib/token/config.js', () => ({ TOKEN_MINT: 'THREEsynthetic1111111111111111111111111111' }));

import { readThreeHolderSnapshot, threeHolderBalances } from '../../api/_lib/coin/three-holders.js';
import { fetchHolderBalances } from '../../api/_lib/coin/holders.js';

beforeEach(() => {
	h.sql.mockReset();
	fetchHolderBalances.mockReset();
});

describe('readThreeHolderSnapshot', () => {
	it('returns null when the snapshot has never been populated', async () => {
		h.sql.mockResolvedValueOnce([{ snapshot_at: null, holder_count: 0 }]); // meta
		expect(await readThreeHolderSnapshot()).toBeNull();
	});

	it('returns null when the snapshot is older than the freshness window', async () => {
		const stale = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h old > 30m max
		h.sql.mockResolvedValueOnce([{ snapshot_at: stale, holder_count: 5 }]); // meta
		expect(await readThreeHolderSnapshot()).toBeNull();
	});

	it('returns null (not an error) when the meta table is missing', async () => {
		h.sql.mockRejectedValueOnce(new Error('relation "three_holder_snapshot_meta" does not exist'));
		expect(await readThreeHolderSnapshot()).toBeNull();
	});

	it('returns a wallet→bigint Map for a fresh snapshot, coercing string balances', async () => {
		h.sql.mockResolvedValueOnce([{ snapshot_at: new Date().toISOString(), holder_count: 2 }]); // meta
		h.sql.mockResolvedValueOnce([
			{ wallet: 'walletA', balance: '300' },
			{ wallet: 'walletB', balance: '100' },
		]); // rows
		const map = await readThreeHolderSnapshot();
		expect(map).toBeInstanceOf(Map);
		expect(map.get('walletA')).toBe(300n);
		expect(map.get('walletB')).toBe(100n);
	});

	it('returns null when a fresh snapshot row set is unexpectedly empty', async () => {
		h.sql.mockResolvedValueOnce([{ snapshot_at: new Date().toISOString(), holder_count: 0 }]); // meta
		h.sql.mockResolvedValueOnce([]); // rows
		expect(await readThreeHolderSnapshot()).toBeNull();
	});
});

describe('threeHolderBalances', () => {
	it('serves the cached snapshot without a live Helius scan', async () => {
		h.sql.mockResolvedValueOnce([{ snapshot_at: new Date().toISOString(), holder_count: 1 }]); // meta
		h.sql.mockResolvedValueOnce([{ wallet: 'walletA', balance: '42' }]); // rows
		const map = await threeHolderBalances();
		expect(map.get('walletA')).toBe(42n);
		expect(fetchHolderBalances).not.toHaveBeenCalled();
	});

	it('falls back to a single live scan when the snapshot is cold/stale', async () => {
		h.sql.mockResolvedValueOnce([{ snapshot_at: null, holder_count: 0 }]); // meta → null snapshot
		fetchHolderBalances.mockResolvedValueOnce(new Map([['walletLive', 7n]]));
		const map = await threeHolderBalances();
		expect(map.get('walletLive')).toBe(7n);
		expect(fetchHolderBalances).toHaveBeenCalledTimes(1);
	});

	it('coalesces concurrent cold reads into ONE scan (stampede guard)', async () => {
		// Every sql call returns a null/cold snapshot so both callers miss cache.
		h.sql.mockResolvedValue([{ snapshot_at: null, holder_count: 0 }]);
		let resolveScan;
		fetchHolderBalances.mockImplementationOnce(
			() => new Promise((r) => { resolveScan = r; }),
		);
		// Fire two concurrent reads against the cold snapshot.
		const p1 = threeHolderBalances();
		const p2 = threeHolderBalances();
		// Let both reach the in-process single-flight before the scan resolves.
		await new Promise((r) => setTimeout(r, 10));
		resolveScan(new Map([['walletLive', 9n]]));
		const [m1, m2] = await Promise.all([p1, p2]);
		expect(m1.get('walletLive')).toBe(9n);
		expect(m2.get('walletLive')).toBe(9n);
		// The whole point: a burst of cold reads fires the expensive scan once.
		expect(fetchHolderBalances).toHaveBeenCalledTimes(1);
	});
});
