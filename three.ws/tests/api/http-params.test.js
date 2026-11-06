// Unit tests for the shared pagination/query helpers in api/_lib/http-params.js.
// These back the `limit`/`offset` clamps used across the public API surface, so
// the coercion + clamping contract is asserted directly here rather than
// per-endpoint.

import { describe, it, expect } from 'vitest';
import { clampInt, parseLimit, parseOffset } from '../../api/_lib/http-params.js';

describe('clampInt', () => {
	it('parses and clamps within [min, max]', () => {
		expect(clampInt('30', { max: 50, fallback: 30 })).toBe(30);
		expect(clampInt('999', { max: 50, fallback: 30 })).toBe(50);
		expect(clampInt('0', { max: 50, fallback: 30 })).toBe(1); // default min = 1
		expect(clampInt('-5', { max: 50, fallback: 30 })).toBe(1);
	});

	it('falls back to `fallback` on missing / non-numeric input (no NaN leak)', () => {
		expect(clampInt(null, { max: 50, fallback: 30 })).toBe(30);
		expect(clampInt(undefined, { max: 50, fallback: 30 })).toBe(30);
		expect(clampInt('', { max: 50, fallback: 30 })).toBe(30);
		expect(clampInt('abc', { max: 50, fallback: 30 })).toBe(30);
		expect(clampInt('12px', { max: 50, fallback: 30 })).toBe(12); // parseInt is lenient by design
	});

	it('accepts numeric input directly', () => {
		expect(clampInt(7, { max: 50, fallback: 30 })).toBe(7);
		expect(clampInt(7.9, { max: 50, fallback: 30 })).toBe(7); // numeric input is truncated to an int
	});

	it('honours a custom min', () => {
		expect(clampInt('0', { min: 0, max: 50, fallback: 10 })).toBe(0);
	});

	it('throws when max/fallback are not finite (programmer error)', () => {
		expect(() => clampInt('1', { fallback: 5 })).toThrow(TypeError);
		expect(() => clampInt('1', { max: 5 })).toThrow(TypeError);
	});
});

describe('parseLimit', () => {
	it('reads from a URLSearchParams source', () => {
		const params = new URLSearchParams('limit=42');
		expect(parseLimit(params, { max: 60, fallback: 24 })).toBe(42);
	});

	it('reads from a plain object source', () => {
		expect(parseLimit({ limit: '500' }, { max: 60, fallback: 24 })).toBe(60);
	});

	it('falls back when the key is absent', () => {
		expect(parseLimit(new URLSearchParams(''), { max: 60, fallback: 24 })).toBe(24);
		expect(parseLimit(null, { max: 60, fallback: 24 })).toBe(24);
	});

	it('supports a custom key', () => {
		expect(parseLimit({ count: '7' }, { max: 60, fallback: 24, key: 'count' })).toBe(7);
	});
});

describe('parseOffset', () => {
	it('floors at 0 and tolerates junk', () => {
		expect(parseOffset(new URLSearchParams('offset=15'))).toBe(15);
		expect(parseOffset(new URLSearchParams('offset=-3'))).toBe(0);
		expect(parseOffset(new URLSearchParams(''))).toBe(0);
		expect(parseOffset({ offset: 'abc' })).toBe(0);
	});

	it('respects a max bound when provided', () => {
		expect(parseOffset({ offset: '9999' }, { max: 1000 })).toBe(1000);
	});
});
