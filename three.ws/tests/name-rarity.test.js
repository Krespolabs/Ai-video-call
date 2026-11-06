// Unit tests for the rare-name rarity pricer (api/_lib/pricing/name-rarity.js).
// Pure logic — proves common names are free (growth) and rare ones are priced.

import { describe, it, expect } from 'vitest';
import { rarityFor, priceName, isValidLabel, RARITY_TIERS } from '../api/_lib/pricing/name-rarity.js';

describe('name rarity', () => {
	it('rarity tiers are ordered rarest→common and bottom out at free', () => {
		for (let i = 1; i < RARITY_TIERS.length; i++) {
			expect(RARITY_TIERS[i].usd).toBeLessThanOrEqual(RARITY_TIERS[i - 1].usd);
		}
		expect(RARITY_TIERS[RARITY_TIERS.length - 1].usd).toBe(0);
	});

	it('1–2 char handles are legendary', () => {
		expect(rarityFor('a').tier).toBe('legendary');
		expect(rarityFor('xy').tier).toBe('legendary');
	});

	it('3 chars, reserved words, and repeats are epic', () => {
		expect(rarityFor('abc').tier).toBe('epic');
		expect(rarityFor('three').tier).toBe('epic'); // reserved
		expect(rarityFor('aaaa').tier).toBe('epic'); // repeating
	});

	it('4 chars or short dictionary words are rare', () => {
		expect(rarityFor('node').tier).toBe('rare'); // 4 chars
		expect(rarityFor('cyber').tier).toBe('rare'); // dictionary
	});

	it('5–6 chars and all-digit handles are uncommon', () => {
		expect(rarityFor('animal').tier).toBe('uncommon'); // 6 chars
		expect(rarityFor('12345678').tier).toBe('uncommon'); // all digits
	});

	it('7+ char standard handles are common and FREE', () => {
		const r = rarityFor('mylongusername');
		expect(r.tier).toBe('common');
		expect(r.free).toBe(true);
		expect(r.usd).toBe(0);
	});

	it('normalizes .threews.sol and .sol suffixes', () => {
		expect(rarityFor('moon.threews.sol').tier).toBe(rarityFor('moon').tier);
	});

	it('isValidLabel rejects bad labels', () => {
		expect(isValidLabel('ok-name')).toBe(true);
		expect(isValidLabel('-bad')).toBe(false);
		expect(isValidLabel('bad-')).toBe(false);
		expect(isValidLabel('UPPER')).toBe(true); // normalized to lower before test
		expect(isValidLabel('has space')).toBe(false);
	});

	it('priceName returns an action for paid names and null for free ones', () => {
		expect(priceName('moon').action).toBe('name.auction'); // dictionary → rare
		expect(priceName('mylongusername').action).toBeNull();
		expect(priceName('mylongusername').free).toBe(true);
	});

	it('priceName throws a typed error on an invalid label', () => {
		expect(() => priceName('-nope')).toThrowError(/invalid name label/);
	});
});
