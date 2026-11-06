import { describe, it, expect } from 'vitest';
import {
	cleanName, deriveSymbol, cleanDescription, validateUseCase, resolveReward, summarizeUseCase,
} from '../api/_lib/launch/usecase-engine.js';
import { listUseCases, getUseCase, categories, USE_CASE_COUNT, allUseCases } from '../api/_lib/launch/registry.js';

describe('identity helpers', () => {
	it('cleanName collapses whitespace and caps at 32 chars', () => {
		expect(cleanName('  hello   world  ')).toBe('hello world');
		expect(cleanName('x'.repeat(40))).toHaveLength(32);
	});
	it('deriveSymbol acronyms multi-word, compacts single-word, uppercases, clamps', () => {
		expect(deriveSymbol('Deep Spec Engine')).toBe('DSE');
		expect(deriveSymbol('widget')).toBe('WIDGET');
		expect(deriveSymbol('a-really-long-project-name')).toBe('ARLPN'); // acronym of the words
		expect(deriveSymbol('supercalifragilisticexpialidocious')).toHaveLength(8); // single word, clamped to default max
		expect(deriveSymbol('supercalifragilistic', { max: 9 })).toHaveLength(9);
		expect(deriveSymbol('')).toBe('COIN');
		expect(deriveSymbol('!!!')).toBe('COIN');
	});
	it('cleanDescription caps at 500 chars', () => {
		expect(cleanDescription('y'.repeat(600))).toHaveLength(500);
	});
});

describe('validateUseCase', () => {
	const ok = {
		id: 'sample-uc', title: 'T', description: 'D', category: 'github', mode: 'attribution',
		source: { kind: 'github-repos' }, naming: () => ({}), rewards: () => ({}),
	};
	it('accepts a well-formed use case', () => {
		expect(validateUseCase(ok)).toBe(true);
	});
	it('rejects a bad id', () => {
		expect(() => validateUseCase({ ...ok, id: 'X' })).toThrow(/invalid id/);
	});
	it('rejects an unknown category and mode', () => {
		expect(() => validateUseCase({ ...ok, category: 'nope' })).toThrow(/invalid category/);
		expect(() => validateUseCase({ ...ok, mode: 'nope' })).toThrow(/invalid mode/);
	});
	it('requires naming and rewards to be functions', () => {
		expect(() => validateUseCase({ ...ok, naming: 'x' })).toThrow(/naming must be a function/);
		expect(() => validateUseCase({ ...ok, rewards: null })).toThrow(/rewards must be a function/);
	});
});

describe('resolveReward (shallow / public preview — no DB)', () => {
	const ctx = { network: 'mainnet' }; // resolve defaults to false
	it('creator spec stays with the creator', async () => {
		const r = await resolveReward({ kind: 'creator' }, ctx);
		expect(r.kind).toBe('creator');
		expect(r.shareholders).toEqual([]);
	});
	it('github-owner returns intent only, never a DB address', async () => {
		const r = await resolveReward({ kind: 'github-owner', github_username: 'nirholas' }, ctx);
		expect(r.kind).toBe('github-owner');
		expect(r.mode).toBe('pending');
		expect(r.shareholders).toEqual([]);
		expect(r.note).toMatch(/@nirholas/);
	});
	it('address spec passes through to a fixed recipient', async () => {
		const r = await resolveReward({ kind: 'address', address: 'A'.repeat(44), share_bps: 10000 }, ctx);
		expect(r.kind).toBe('address');
		expect(r.shareholders[0].address).toBe('A'.repeat(44));
	});
	it('split returns the recipient count as intent', async () => {
		const r = await resolveReward({ kind: 'split', shareholders: [{ github_username: 'a' }, { github_username: 'b' }] }, ctx);
		expect(r.kind).toBe('split');
		expect(r.note).toMatch(/2 recipients/);
	});
	it('x-owner routes to an X account (intent only)', async () => {
		const r = await resolveReward({ kind: 'x-owner', username: 'naval' }, ctx);
		expect(r.kind).toBe('x-owner');
		expect(r.platform).toBe('x');
		expect(r.mode).toBe('pending');
		expect(r.note).toMatch(/@naval on X/);
	});
	it('cashback returns holders as the beneficiary', async () => {
		const r = await resolveReward({ kind: 'cashback' }, ctx);
		expect(r.kind).toBe('cashback');
		expect(r.shareholders).toEqual([]);
	});
	it('buyback carries its basis points', async () => {
		const r = await resolveReward({ kind: 'buyback', buyback_bps: 5000 }, ctx);
		expect(r.kind).toBe('buyback');
		expect(r.buyback_bps).toBe(5000);
		expect(r.note).toMatch(/50%/);
	});
});

describe('registry integrity', () => {
	it('holds exactly 50 use cases with unique ids', () => {
		expect(USE_CASE_COUNT).toBe(50);
		const ids = allUseCases().map((u) => u.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
	it('every use case validates and summarizes with required fields', () => {
		for (const uc of allUseCases()) {
			expect(validateUseCase(uc)).toBe(true);
			const s = summarizeUseCase(uc);
			expect(s.id).toBeTruthy();
			expect(s.title).toBeTruthy();
			expect(s.description).toBeTruthy();
			expect(['github', 'culture', 'news', 'onchain', 'events', 'community']).toContain(s.category);
			expect(['attribution', 'narrative']).toContain(s.mode);
		}
	});
	it('covers all six categories', () => {
		expect(categories().sort()).toEqual(['community', 'culture', 'events', 'github', 'news', 'onchain']);
	});
	it('lists are filterable by category and mode', () => {
		expect(listUseCases({ category: 'github' }).every((u) => u.category === 'github')).toBe(true);
		expect(listUseCases({ mode: 'attribution' }).every((u) => u.mode === 'attribution')).toBe(true);
	});
	it('getUseCase returns an object for a known id and null otherwise', () => {
		expect(getUseCase('github-trending-repos')).toBeTruthy();
		expect(getUseCase('does-not-exist')).toBeNull();
	});
});
