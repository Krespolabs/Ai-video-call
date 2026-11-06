// Oracle source adapter — assembleIntel outage semantics.
//
// Regression guard: the primary coin lookup must distinguish a genuinely-unknown
// coin (empty result → null) from a database outage (query throws → propagate).
// Collapsing both into null made /api/oracle/coin return a misleading 404 during
// a DB/connection outage, which clients and the CDN then cached as an
// authoritative "this mint doesn't exist". A thrown error must reach the caller
// so it can answer 503 instead.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...args) => sqlMock(...args),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { assembleIntel } = await import('../../api/_lib/oracle/sources.js');

describe('assembleIntel — outage vs unknown', () => {
	beforeEach(() => sqlMock.mockReset());

	it('returns null when the coin is genuinely unknown (empty primary result)', async () => {
		sqlMock.mockResolvedValue([]);
		await expect(assembleIntel('MintUnknownAAA', 'mainnet')).resolves.toBeNull();
	});

	it('throws when the primary lookup fails (DB outage) — never a silent null', async () => {
		// Model the outage as an async rejection created lazily inside the mock
		// implementation (an async fn that throws). A pre-built `mockRejectedValue`
		// Error leaks its rejected promise to Vitest's worker-level unhandled-
		// rejection tracker once this file has >1 test sharing the module mock,
		// which fails the run even though the production code propagates correctly.
		sqlMock.mockImplementationOnce(async () => {
			throw new Error('db query exceeded 15000ms deadline');
		});
		await expect(assembleIntel('MintXYZ', 'mainnet')).rejects.toThrow(/deadline/);
	});

	it('refuses quote/stablecoin mints (USDC) without ever touching the DB', async () => {
		// USDC is the swap counter-side, never a launched coin. assembleIntel must
		// short-circuit to null before any query so it can never be scored/cached
		// (regression: USDC surfaced in the wins gallery as "$EPJFWD" at 32,905,333×).
		const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
		await expect(assembleIntel(USDC, 'mainnet')).resolves.toBeNull();
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
