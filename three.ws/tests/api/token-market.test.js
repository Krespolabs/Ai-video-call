import { describe, it, expect } from 'vitest';

// Pure-logic only — the shared, coin-agnostic helpers behind the CA → x402
// resolver (/ca2x402) and the generic /api/x402/token-intel service. We cover:
//   • isResolvableAddress / chainOf classification (Solana mint vs EVM 0x)
//   • buildTokenSignal thresholds (bullish >5,>1 · bearish <-5,<-1 · neutral)
//     and that headlines/rationale are branded to the token's own symbol
import {
	isResolvableAddress,
	chainOf,
	buildTokenSignal,
} from '../../api/_lib/token-market.js';

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM = '0x1234567890abcdef1234567890abcdef12345678';

describe('isResolvableAddress / chainOf', () => {
	it('accepts a Solana base58 mint', () => {
		expect(isResolvableAddress(THREE)).toBe(true);
		expect(chainOf(THREE)).toBe('solana');
	});
	it('accepts an EVM 0x address', () => {
		expect(isResolvableAddress(EVM)).toBe(true);
		expect(chainOf(EVM)).toBe('evm');
	});
	it('rejects garbage and empty input', () => {
		expect(isResolvableAddress('')).toBe(false);
		expect(isResolvableAddress('not-an-address')).toBe(false);
		expect(isResolvableAddress('0xzzzz')).toBe(false);
		expect(chainOf('nope')).toBe(null);
	});
});

describe('buildTokenSignal — thresholds', () => {
	const base = { symbol: 'WIDGET', price_usd: 0.0012, volume_24h_usd: 50000, liquidity_usd: 25000 };

	it('strong move up is bullish', () => {
		const s = buildTokenSignal({ ...base, change_24h: 12.4 });
		expect(s.signal).toBe('bullish');
		expect(s.confidence).toBeGreaterThan(0.6);
	});
	it('mild up move is bullish', () => {
		expect(buildTokenSignal({ ...base, change_24h: 2.1 }).signal).toBe('bullish');
	});
	it('strong move down is bearish', () => {
		expect(buildTokenSignal({ ...base, change_24h: -9.8 }).signal).toBe('bearish');
	});
	it('mild down move is bearish', () => {
		expect(buildTokenSignal({ ...base, change_24h: -1.7 }).signal).toBe('bearish');
	});
	it('flat move is neutral', () => {
		expect(buildTokenSignal({ ...base, change_24h: 0.3 }).signal).toBe('neutral');
	});
});

describe('buildTokenSignal — branding', () => {
	it('brands headline + rationale to the token symbol (uppercased)', () => {
		const s = buildTokenSignal({
			symbol: 'pepe', price_usd: 0.5, change_24h: 8, volume_24h_usd: 1000, liquidity_usd: 1000,
		});
		expect(s.headline).toContain('PEPE');
		expect(s.rationale).toContain('PEPE');
	});
	it('falls back to TOKEN when symbol is missing', () => {
		const s = buildTokenSignal({ symbol: null, price_usd: 1, change_24h: 0, volume_24h_usd: 0, liquidity_usd: 0 });
		expect(s.headline).toContain('TOKEN');
	});
	it('confidence stays within [0,1]', () => {
		const s = buildTokenSignal({ symbol: 'X', price_usd: 1, change_24h: 999, volume_24h_usd: 9e9, liquidity_usd: 1 });
		expect(s.confidence).toBeGreaterThanOrEqual(0);
		expect(s.confidence).toBeLessThanOrEqual(1);
	});
});
