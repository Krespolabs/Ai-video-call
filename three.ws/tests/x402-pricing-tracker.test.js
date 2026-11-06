import { describe, it, expect } from 'vitest';
import {
	pctChange,
	priceRecordFromDetails,
	extractDetails,
} from '../api/_lib/x402/pipelines/x402-pricing-tracker.js';

describe('pctChange', () => {
	it('computes a percentage hike', () => {
		expect(pctChange(1000, 1300)).toBe(30);
	});
	it('computes a percentage drop', () => {
		expect(pctChange(1000, 800)).toBe(-20);
	});
	it('returns null with no comparable baseline', () => {
		expect(pctChange(null, 1000)).toBeNull();
		expect(pctChange(0, 1000)).toBeNull();
		expect(pctChange(1000, null)).toBeNull();
	});
});

describe('priceRecordFromDetails', () => {
	const fallback = { service_key: 'r#t', resource: 'r', tool_name: 't' };

	it('selects the cheapest price across networks', () => {
		const rec = priceRecordFromDetails(
			{
				service_key: 'r#t',
				resource: 'https://svc.test',
				tool_name: 't',
				name: 'Svc',
				available: true,
				min_price_atomic: 2000,
				prices: [
					{ network: 'eip155:8453', amount_atomic: 2000, asset: 'A', price: '$0.002' },
					{ network: 'solana:mainnet', amount_atomic: 1500, asset: 'B', price: '$0.0015' },
				],
			},
			fallback,
		);
		expect(rec.price_atomic).toBe(1500);
		expect(rec.network).toBe('solana:mainnet');
		expect(rec.price_label).toBe('$0.0015');
		expect(rec.available).toBe(true);
	});

	it('marks an unlisted service unavailable with a null price', () => {
		const rec = priceRecordFromDetails(
			{ service_key: 'r#t', resource: 'r', tool_name: 't', available: false, prices: [], min_price_atomic: null },
			fallback,
		);
		expect(rec.available).toBe(false);
		expect(rec.price_atomic).toBeNull();
	});

	it('falls back to the tracked identity when the payload omits it', () => {
		const rec = priceRecordFromDetails({ available: true, prices: [{ network: 'x', amount_atomic: 1000 }] }, fallback);
		expect(rec.service_key).toBe('r#t');
		expect(rec.resource).toBe('r');
		expect(rec.price_atomic).toBe(1000);
	});
});

describe('extractDetails', () => {
	it('pulls structuredContent out of a JSON-RPC tools/call body', () => {
		const { details, rpcError } = extractDetails({ result: { structuredContent: { available: true, min_price_atomic: 1000 } } });
		expect(details.min_price_atomic).toBe(1000);
		expect(rpcError).toBeNull();
	});
	it('surfaces a JSON-RPC error and a null details payload', () => {
		const { details, rpcError } = extractDetails({ error: { code: -32000, message: 'rate_limited' } });
		expect(details).toBeNull();
		expect(rpcError).toMatchObject({ code: -32000 });
	});
});
