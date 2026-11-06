// Unit tests for the GeckoTerminal → trade-tape normalizer behind
// /api/pump/dex-trades. Pure mapping logic — no network.

import { describe, it, expect } from 'vitest';
import { normalizeGtTrade } from '../../api/pump/dex-trades.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('normalizeGtTrade', () => {
	it('maps a buy: SOL is the from leg, the token is the to leg', () => {
		const t = {
			attributes: {
				kind: 'buy',
				block_timestamp: '2026-06-21T11:52:25Z',
				tx_hash: 'SIGBUY',
				tx_from_address: 'BuyerWallet',
				volume_in_usd: '786.99239',
				from_token_amount: '10.728569908', // SOL in
				to_token_amount: '221437.075234', // THREE out
			},
		};
		const v = normalizeGtTrade(t, MINT);
		expect(v.is_buy).toBe(true);
		expect(v.txType).toBe('buy');
		expect(v.trader).toBe('BuyerWallet');
		expect(v.signature).toBe('SIGBUY');
		expect(v.sol_amount).toBeCloseTo(10.728569908, 6);
		expect(v.token_amount).toBeCloseTo(221437.075234, 4);
		expect(v.sol_value_usd).toBeCloseTo(786.99239, 4);
		expect(v.timestamp).toBe(Math.floor(Date.parse('2026-06-21T11:52:25Z') / 1000));
		expect(v.mint).toBe(MINT);
	});

	it('maps a sell: the token is the from leg, SOL is the to leg', () => {
		const t = {
			attributes: {
				kind: 'sell',
				block_timestamp: '2026-06-21T11:52:27Z',
				tx_hash: 'SIGSELL',
				tx_from_address: 'SellerWallet',
				volume_in_usd: '14.4066',
				from_token_amount: '4062.53', // THREE in
				to_token_amount: '0.196396916', // SOL out
			},
		};
		const v = normalizeGtTrade(t, MINT);
		expect(v.is_buy).toBe(false);
		expect(v.txType).toBe('sell');
		expect(v.sol_amount).toBeCloseTo(0.196396916, 6);
		expect(v.token_amount).toBeCloseTo(4062.53, 2);
		expect(v.sol_value_usd).toBeCloseTo(14.4066, 4);
	});

	it('nulls non-finite numeric fields rather than emitting NaN', () => {
		const v = normalizeGtTrade({ attributes: { kind: 'buy', tx_hash: 'X' } }, MINT);
		expect(v.sol_amount).toBeNull();
		expect(v.token_amount).toBeNull();
		expect(v.sol_value_usd).toBeNull();
		expect(v.timestamp).toBeNull();
	});
});
