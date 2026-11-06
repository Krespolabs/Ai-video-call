import { describe, it, expect } from 'vitest';
import { randomCoin, sanitizeName, sanitizeSymbol } from '../api/_lib/launcher-sources.js';

describe('sanitizeName', () => {
	it('collapses whitespace and trims', () => {
		expect(sanitizeName('  Turbo   Otter  ')).toBe('Turbo Otter');
	});
	it('caps at 32 chars (pump.fun limit)', () => {
		expect(sanitizeName('x'.repeat(80)).length).toBe(32);
	});
	it('never throws on null/undefined', () => {
		expect(sanitizeName(null)).toBe('');
		expect(sanitizeName(undefined)).toBe('');
	});
});

describe('sanitizeSymbol', () => {
	it('uppercases and strips non-alphanumerics', () => {
		expect(sanitizeSymbol('tur-bo!')).toBe('TURBO');
	});
	it('caps at 10 chars', () => {
		expect(sanitizeSymbol('ABCDEFGHIJKLMNOP').length).toBe(10);
	});
	it('falls back to a valid ticker when empty', () => {
		expect(sanitizeSymbol('@@@')).toBe('THREE3');
		expect(sanitizeSymbol('')).toBe('THREE3');
	});
});

describe('randomCoin', () => {
	it('always returns a launch-valid coin within pump.fun caps', () => {
		for (let i = 0; i < 200; i++) {
			const c = randomCoin();
			expect(c.kind).toBe('random');
			expect(c.name.length).toBeGreaterThan(0);
			expect(c.name.length).toBeLessThanOrEqual(32);
			expect(c.symbol).toMatch(/^[A-Z0-9]{1,10}$/);
			expect(typeof c.description).toBe('string');
			expect(c.trigger_source).toBe('random');
		}
	});
});
