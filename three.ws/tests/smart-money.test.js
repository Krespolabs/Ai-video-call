import { describe, it, expect } from 'vitest';
import { attributeCoin, computeReputation, EARLY_WINDOW_SEC } from '../src/pump/wallet-reputation.js';
import { computeCoinSmartMoney } from '../src/pump/smart-money-score.js';

const SOL = 1_000_000_000;

describe('attributeCoin — per-coin verdict folding', () => {
	const coinTs = 1000;
	const w = (over = {}) => ({ buy_lamports: SOL, sell_lamports: 0, first_seen_ts: 1010, is_creator: false, ...over });

	it('credits an early buyer of a graduate as an early win', () => {
		const d = attributeCoin({ outcome: 'graduated', wallet: w(), coinFirstSeenTs: coinTs });
		expect(d.coins_traded).toBe(1);
		expect(d.wins).toBe(1);
		expect(d.early_entries).toBe(1);
		expect(d.early_wins).toBe(1);
		expect(d.duds).toBe(0);
	});

	it('a late buyer of a graduate wins but is not "early"', () => {
		const late = w({ first_seen_ts: coinTs + EARLY_WINDOW_SEC + 60 });
		const d = attributeCoin({ outcome: 'graduated', wallet: late, coinFirstSeenTs: coinTs });
		expect(d.wins).toBe(1);
		expect(d.early_entries).toBe(0);
		expect(d.early_wins).toBe(0);
	});

	it('a buyer of a dud takes a dud, no win', () => {
		const d = attributeCoin({ outcome: 'dud', wallet: w(), coinFirstSeenTs: coinTs });
		expect(d.duds).toBe(1);
		expect(d.wins).toBe(0);
	});

	it('flags a dump when sells reach half the buy', () => {
		const d = attributeCoin({ outcome: 'graduated', wallet: w({ sell_lamports: SOL / 2 }), coinFirstSeenTs: coinTs });
		expect(d.dumps).toBe(1);
	});

	it('a non-buyer earns no trading verdict, but creator counters still apply', () => {
		const d = attributeCoin({ outcome: 'dud', wallet: w({ buy_lamports: 0, is_creator: true }), coinFirstSeenTs: coinTs });
		expect(d.coins_traded).toBe(0);
		expect(d.duds).toBe(0);
		expect(d.creator_count).toBe(1);
		expect(d.creator_wins).toBe(0);
	});

	it('credits a creator win when their coin graduates', () => {
		const d = attributeCoin({ outcome: 'graduated', wallet: w({ is_creator: true }), coinFirstSeenTs: coinTs });
		expect(d.creator_wins).toBe(1);
	});
});

describe('computeReputation — label + score', () => {
	it('labels a thin record as fresh regardless of a lucky win', () => {
		const r = computeReputation({ wins: 1, duds: 0, coins_traded: 1, early_entries: 1, early_wins: 1 });
		expect(r.label).toBe('fresh');
		expect(r.smart_money_score).toBeLessThan(70); // confidence-gated
	});

	it('promotes a proven early winner to smart_money', () => {
		const r = computeReputation({
			wins: 18, duds: 4, coins_traded: 22, early_entries: 20, early_wins: 16, dumps: 1,
		});
		expect(r.win_rate).toBeGreaterThan(75);
		expect(r.label).toBe('smart_money');
		expect(r.smart_money_score).toBeGreaterThanOrEqual(70);
	});

	it('labels a serial rugging creator', () => {
		const r = computeReputation({ creator_count: 6, creator_wins: 0, coins_traded: 6, wins: 0, duds: 6 });
		expect(r.label).toBe('rugger');
	});

	it('labels a heavy dumper', () => {
		const r = computeReputation({ wins: 6, duds: 6, coins_traded: 12, dumps: 9, early_entries: 8, early_wins: 4 });
		expect(r.label).toBe('dumper');
		expect(r.dump_rate).toBeGreaterThanOrEqual(60);
	});

	it('labels a spray sniper: early into everything, rarely wins', () => {
		const r = computeReputation({ wins: 2, duds: 18, coins_traded: 20, early_entries: 18, early_wins: 2, dumps: 2 });
		expect(r.label).toBe('sniper');
	});

	it('an empty record is unproven with zero score', () => {
		const r = computeReputation({});
		expect(r.smart_money_score).toBe(0);
		expect(r.label).toBe('fresh');
	});
});

describe('computeCoinSmartMoney — coin pedigree', () => {
	const rep = new Map([
		['A', { smart_money_score: 90, label: 'smart_money' }],
		['B', { smart_money_score: 80, label: 'smart_money' }],
		['C', { smart_money_score: 10, label: 'neutral' }],
	]);

	it('scores high when proven wallets dominate the buys', () => {
		const wallets = [
			{ wallet: 'A', buy_lamports: 5 * SOL },
			{ wallet: 'B', buy_lamports: 3 * SOL },
			{ wallet: 'C', buy_lamports: 1 * SOL },
		];
		const r = computeCoinSmartMoney(wallets, rep);
		expect(r.smart_wallet_count).toBe(2);
		expect(r.smart_money_score).toBeGreaterThan(70);
		expect(r.notable[0].wallet).toBe('A');
		expect(r.notable).toHaveLength(3);
	});

	it('scores low when only unknown wallets are buying', () => {
		const wallets = [
			{ wallet: 'X', buy_lamports: 4 * SOL },
			{ wallet: 'Y', buy_lamports: 2 * SOL },
		];
		const r = computeCoinSmartMoney(wallets, rep);
		expect(r.smart_wallet_count).toBe(0);
		expect(r.smart_money_score).toBe(0);
		expect(r.notable).toHaveLength(0);
	});

	it('ignores the creator and zero-buy rows', () => {
		const wallets = [
			{ wallet: 'A', buy_lamports: 5 * SOL, is_creator: true },
			{ wallet: 'B', buy_lamports: 0 },
			{ wallet: 'C', buy_lamports: 2 * SOL },
		];
		const r = computeCoinSmartMoney(wallets, rep);
		// only C counts → low pedigree, A excluded as creator
		expect(r.total_buy_lamports).toBe(2 * SOL);
		expect(r.smart_wallet_count).toBe(0);
	});
});
