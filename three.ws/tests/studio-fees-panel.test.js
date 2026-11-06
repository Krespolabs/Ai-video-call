import { describe, it, expect } from 'vitest';
import { parseGithubRepo, parseGithubAccount, weightsToBps, validateShareSplit } from '../public/studio/fees-panel.js';

// A plausible 44-char base58 Solana address for split validation tests.
const A = (c) => c.repeat(44);

describe('parseGithubRepo', () => {
	it('parses owner/repo', () => {
		expect(parseGithubRepo('solana-labs/solana')).toEqual({ owner: 'solana-labs', repo: 'solana' });
	});
	it('parses a full github URL', () => {
		expect(parseGithubRepo('https://github.com/anza-xyz/agave')).toEqual({ owner: 'anza-xyz', repo: 'agave' });
	});
	it('strips a trailing .git and slash', () => {
		expect(parseGithubRepo('github.com/foo/bar.git/')).toEqual({ owner: 'foo', repo: 'bar' });
	});
	it('rejects empty / malformed input', () => {
		expect(parseGithubRepo('')).toBeNull();
		expect(parseGithubRepo('justaname')).toBeNull();
		expect(parseGithubRepo('   ')).toBeNull();
	});
});

describe('parseGithubAccount', () => {
	it('parses a bare login', () => {
		expect(parseGithubAccount('nirholas')).toBe('nirholas');
	});
	it('strips a leading @', () => {
		expect(parseGithubAccount('@nirholas')).toBe('nirholas');
	});
	it('parses a profile URL', () => {
		expect(parseGithubAccount('https://github.com/anza-xyz')).toBe('anza-xyz');
		expect(parseGithubAccount('github.com/foo-bar/')).toBe('foo-bar');
	});
	it('accepts a hyphenated login but rejects leading/trailing/double hyphens', () => {
		expect(parseGithubAccount('a-b-c')).toBe('a-b-c');
		expect(parseGithubAccount('-bad')).toBeNull();
		expect(parseGithubAccount('bad-')).toBeNull();
		expect(parseGithubAccount('a--b')).toBeNull();
	});
	it('rejects empty / over-long / invalid logins', () => {
		expect(parseGithubAccount('')).toBeNull();
		expect(parseGithubAccount('   ')).toBeNull();
		expect(parseGithubAccount('a'.repeat(40))).toBeNull();
		expect(parseGithubAccount('has space')).toBeNull();
	});
});

describe('weightsToBps', () => {
	it('always sums to exactly 10000', () => {
		for (const ws of [[1], [1, 1, 1], [5, 3, 2], [100, 1, 1, 1], [7, 7, 7, 7, 7, 7, 7]]) {
			expect(weightsToBps(ws).reduce((a, b) => a + b, 0)).toBe(10_000);
		}
	});
	it('splits evenly with largest-remainder rounding', () => {
		expect(weightsToBps([1, 1, 1])).toEqual([3334, 3333, 3333]);
	});
	it('weights proportionally', () => {
		expect(weightsToBps([3, 1])).toEqual([7500, 2500]);
	});
	it('handles all-zero weights without NaN', () => {
		expect(weightsToBps([0, 0])).toEqual([0, 0]);
	});
});

describe('validateShareSplit', () => {
	it('accepts a clean 50/50 split', () => {
		const r = validateShareSplit([{ address: A('1'), bps: 5000 }, { address: A('2'), bps: 5000 }]);
		expect(r.ok).toBe(true);
		expect(r.totalBps).toBe(10_000);
	});
	it('rejects when shares do not total 100%', () => {
		const r = validateShareSplit([{ address: A('1'), bps: 5000 }, { address: A('2'), bps: 4000 }]);
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => /100%/.test(e))).toBe(true);
	});
	it('rejects a recipient with no wallet', () => {
		const r = validateShareSplit([{ address: '', bps: 10_000 }]);
		expect(r.ok).toBe(false);
	});
	it('rejects duplicate wallets', () => {
		const r = validateShareSplit([{ address: A('1'), bps: 5000 }, { address: A('1'), bps: 5000 }]);
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => /Duplicate/.test(e))).toBe(true);
	});
	it('rejects more than 10 recipients', () => {
		const rows = Array.from({ length: 11 }, (_, i) => ({ address: A(String.fromCharCode(65 + i)), bps: 909 }));
		const r = validateShareSplit(rows);
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => /Maximum 10/.test(e))).toBe(true);
	});
	it('rejects an empty list', () => {
		expect(validateShareSplit([]).ok).toBe(false);
	});
});
