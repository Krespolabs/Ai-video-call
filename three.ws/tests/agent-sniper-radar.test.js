import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { scoreRadarEvent } from '../workers/agent-sniper/radar-scorer.js';
import { parseCreateMint, parseFundingTransfers, classifyTransaction } from '../workers/agent-sniper/radar-detect.js';
import { curateWatchlist } from '../workers/agent-sniper/radar-watchlist.js';
import { PUMP_PROGRAM_ID, CREATE_DISCRIMINATOR, CREATE_V2_DISCRIMINATOR } from '../api/_lib/solana/programs.js';

// Synthetic placeholder addresses only — never a real mint/wallet.
const MINT = 'THREEsynthetic1111111111111111111111111111111';
const WATCHED = 'Watched1111111111111111111111111111111111111';
const FRESH = 'FreshWa11et2222222222222222222222222222222222';

const cfg = {
	radarMaxAgeMs: 120_000,
	radarMinCreatorGraduated: 2,
	radarSmartMoneyMinScore: 70,
};

function ev(overrides = {}) {
	return {
		kind: 'create',
		trigger_wallet: WATCHED,
		mint: MINT,
		signature: 'sig_radar_1',
		base_confidence: 0.9,
		observed_ms: Date.now(),
		watch: { reason: 'creator_graduated', score: 70, creator_graduated: 3, labels: ['creator'] },
		...overrides,
	};
}

describe('scoreRadarEvent — pre-launch radar entry filter', () => {
	it('skips an event with no mint', () => {
		const r = scoreRadarEvent(ev({ mint: null }), {}, cfg);
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('no_mint');
	});

	it('passes a proven-creator precursor with default gates', () => {
		const r = scoreRadarEvent(ev(), {}, cfg);
		expect(r.pass).toBe(true);
		expect(r.confidence).toBeGreaterThan(0.9);
		expect(r.reasons.some((x) => x.startsWith('creator_graduated:'))).toBe(true);
	});

	it('rejects a stale precursor past radar_max_age_ms', () => {
		const r = scoreRadarEvent(ev({ observed_ms: Date.now() - 5 * 60_000 }), { radar_max_age_ms: 60_000 }, cfg);
		expect(r.pass).toBe(false);
		expect(r.reasons[0]).toMatch(/precursor_stale/);
	});

	it('rejects a creator below min_creator_graduated_radar (non-smart-money watch)', () => {
		const r = scoreRadarEvent(
			ev({ watch: { reason: 'creator_graduated', score: 50, creator_graduated: 1, labels: ['creator'] } }),
			{ min_creator_graduated_radar: 3 },
			cfg,
		);
		expect(r.pass).toBe(false);
		expect(r.reasons[0]).toMatch(/creator_too_few_graduated/);
	});

	it('lets a smart-money-reason watch through the creator pedigree gate', () => {
		const r = scoreRadarEvent(
			ev({ watch: { reason: 'smart_money', score: 88, creator_graduated: null, realized_score: 88, labels: ['smart_money'] } }),
			{ min_creator_graduated_radar: 3 },
			cfg,
		);
		expect(r.pass).toBe(true);
	});

	it('blocks when require_smart_money_funder is set but no proof exists', () => {
		const r = scoreRadarEvent(
			ev({ funder_reputation: { computed: true, realized_score: 10 } }),
			{ require_smart_money_funder: true },
			cfg,
		);
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('no_smart_money_funder');
	});

	it('passes require_smart_money_funder with a proven funder', () => {
		const r = scoreRadarEvent(
			ev({ funder_reputation: { computed: true, realized_score: 82, labels: ['smart_money'] } }),
			{ require_smart_money_funder: true },
			cfg,
		);
		expect(r.pass).toBe(true);
		expect(r.reasons.some((x) => x.startsWith('smart_money_funder:'))).toBe(true);
	});

	it('clamps confidence to [0,1] and lifts it with funder reputation', () => {
		const r = scoreRadarEvent(
			ev({ base_confidence: 0.5, funder_reputation: { computed: true, realized_score: 100 } }),
			{},
			cfg,
		);
		expect(r.confidence).toBeGreaterThan(0.5);
		expect(r.confidence).toBeLessThanOrEqual(1);
	});
});

// ── detection parsers ─────────────────────────────────────────────────────────

function createTx({ variant = 'create', mint = MINT, inner = false } = {}) {
	const disc = variant === 'create_v2' ? CREATE_V2_DISCRIMINATOR : CREATE_DISCRIMINATOR;
	const data = bs58.encode(Buffer.concat([disc, Buffer.alloc(16)]));
	const ix = { programId: PUMP_PROGRAM_ID, accounts: [mint, 'aaaa', 'bbbb'], data };
	return {
		meta: { err: null, innerInstructions: inner ? [{ index: 0, instructions: [ix] }] : [] },
		transaction: { message: { instructions: inner ? [] : [ix] } },
	};
}

function fundingTx({ from = WATCHED, to = FRESH, lamports = 50_000_000 } = {}) {
	return {
		meta: { err: null, innerInstructions: [] },
		transaction: {
			message: {
				instructions: [
					{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: from, destination: to, lamports } } },
				],
			},
		},
	};
}

describe('parseCreateMint — pump.fun create detection', () => {
	it('extracts the mint from an outer create instruction', () => {
		const r = parseCreateMint(createTx());
		expect(r).toEqual({ mint: MINT, variant: 'create' });
	});

	it('extracts the mint from a create_v2 instruction', () => {
		const r = parseCreateMint(createTx({ variant: 'create_v2' }));
		expect(r.variant).toBe('create_v2');
		expect(r.mint).toBe(MINT);
	});

	it('finds a create nested in inner instructions', () => {
		const r = parseCreateMint(createTx({ inner: true }));
		expect(r?.mint).toBe(MINT);
	});

	it('returns null for a non-create transaction', () => {
		expect(parseCreateMint(fundingTx())).toBeNull();
	});

	it('returns null on a failed transaction', () => {
		const tx = createTx();
		tx.meta.err = { InstructionError: [0, 'Custom'] };
		expect(parseCreateMint(tx)).toBeNull();
	});
});

describe('parseFundingTransfers — fresh deploy-wallet funding detection', () => {
	it('detects a SOL transfer out of the watched wallet', () => {
		const r = parseFundingTransfers(fundingTx(), WATCHED);
		expect(r).toEqual([{ destination: FRESH, lamports: 50_000_000 }]);
	});

	it('ignores transfers not sourced from the watched wallet', () => {
		expect(parseFundingTransfers(fundingTx({ from: 'Someone1111111111111111111111111111111111111' }), WATCHED)).toEqual([]);
	});

	it('ignores self-transfers and system/wsol destinations', () => {
		expect(parseFundingTransfers(fundingTx({ to: WATCHED }), WATCHED)).toEqual([]);
		expect(parseFundingTransfers(fundingTx({ to: 'So11111111111111111111111111111111111111112' }), WATCHED)).toEqual([]);
	});

	it('aggregates multiple transfers to the same destination', () => {
		const tx = fundingTx();
		tx.transaction.message.instructions.push({
			program: 'system', parsed: { type: 'transfer', info: { source: WATCHED, destination: FRESH, lamports: 10_000_000 } },
		});
		const r = parseFundingTransfers(tx, WATCHED);
		expect(r).toEqual([{ destination: FRESH, lamports: 60_000_000 }]);
	});
});

describe('classifyTransaction', () => {
	it('returns both create and fundings shape', () => {
		const c = classifyTransaction(createTx(), WATCHED);
		expect(c.create?.mint).toBe(MINT);
		expect(c.fundings).toEqual([]);
		const f = classifyTransaction(fundingTx(), WATCHED);
		expect(f.create).toBeNull();
		expect(f.fundings.length).toBe(1);
	});
});

// ── watchlist curation ────────────────────────────────────────────────────────

describe('curateWatchlist — merge + cap + score', () => {
	it('scores creators by graduation count and smart money by reputation', () => {
		const out = curateWatchlist({
			creators: [{ address: 'C1', graduated: 4, launches: 9 }],
			smartMoney: [{ address: 'S1', realized_score: 90, labels: ['smart_money'] }],
			cap: 10,
		});
		const c1 = out.find((w) => w.address === 'C1');
		const s1 = out.find((w) => w.address === 'S1');
		expect(c1.reason).toBe('creator_graduated');
		expect(c1.score).toBe(90); // 50 + 4*10, capped at 95
		expect(c1.creator_graduated).toBe(4);
		expect(s1.reason).toBe('smart_money');
		expect(s1.score).toBe(90);
	});

	it('merges a wallet that is both a proven creator and smart money, keeping both signals', () => {
		const out = curateWatchlist({
			creators: [{ address: 'BOTH', graduated: 2, launches: 3 }],
			smartMoney: [{ address: 'BOTH', realized_score: 95, labels: ['smart_money'] }],
			cap: 10,
		});
		expect(out.length).toBe(1);
		expect(out[0].creator_graduated).toBe(2);
		expect(out[0].realized_score).toBe(95);
		expect(out[0].score).toBe(95); // max of creator(70) and smart money(95)
		expect(out[0].labels).toEqual(expect.arrayContaining(['creator', 'smart_money']));
	});

	it('drops zero-signal candidates and caps the set by score', () => {
		const out = curateWatchlist({
			creators: [{ address: 'C0', graduated: 0, launches: 5 }, { address: 'C1', graduated: 1, launches: 2 }],
			smartMoney: [{ address: 'S0', realized_score: 0, labels: [] }, { address: 'S1', realized_score: 80, labels: [] }],
			cap: 1,
		});
		expect(out.length).toBe(1);
		expect(out[0].address).toBe('S1'); // highest score wins the single slot
	});
});
