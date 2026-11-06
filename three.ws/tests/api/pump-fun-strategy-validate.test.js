// Semantic strategy validation (Task 06). Covers the pure static validator
// (validateStrategySpec), the live validateStrategy handler (mint existence +
// quote-asset reconciliation), and the run/backtest pre-flight gate. Each
// rejection class has a case, and the shipped presets are asserted clean so the
// validator never produces a false positive on a working strategy.

import { describe, it, expect } from 'vitest';
import {
	validateStrategySpec,
	strategyErrors,
} from '../../examples/skills/pump-fun-strategy/dsl.js';
import {
	validateStrategy,
	runStrategy,
	backtestStrategy,
} from '../../examples/skills/pump-fun-strategy/handlers.js';

// Clearly-synthetic, base58-shaped placeholder mint (never a real coin).
const SYNTH_MINT = 'THREEsynthetic1111111111111111111111111111';

const errorsOf = (spec) => validateStrategySpec(spec).issues.filter((i) => i.level === 'error');
const codesOf = (spec, level) =>
	validateStrategySpec(spec).issues.filter((i) => !level || i.level === level).map((i) => i.code);

const validBase = (over = {}) => ({
	scan: { kind: 'newTokens', limit: 10 },
	filters: ['holders.total > 50'],
	entry: { side: 'buy', amountSol: 0.05 },
	exit: [{ if: 'position.pnlPct > 75', do: { side: 'sell', percent: 100 } }],
	caps: { sessionSpendCapSol: 0.5, maxOpenPositions: 5 },
	...over,
});

const PRESETS = {
	momentum: {
		scan: { kind: 'newTokens', limit: 10 },
		filters: ['holders.total > 50', 'holders.topHolderPct < 25', 'creator.rugCount == 0'],
		entry: { side: 'buy', amountSol: 0.05 },
		exit: [
			{ if: 'position.pnlPct > 75', do: { side: 'sell', percent: 100 } },
			{ if: 'position.pnlPct < -30', do: { side: 'sell', percent: 100 } },
			{ if: 'holders.topHolderPct > 40', do: { side: 'sell', percent: 100 } },
		],
		caps: { sessionSpendCapSol: 0.5, perTradeSol: 0.05, maxOpenPositions: 5 },
	},
	snipe: {
		scan: { kind: 'newTokens', limit: 20 },
		filters: ['holders.total > 30', 'creator.rugCount == 0'],
		entry: { side: 'buy', amountSol: 0.025 },
		exit: [
			{ if: 'position.pnlPct > 100', do: { side: 'sell', percent: 100 } },
			{ if: 'position.ageSec > 600', do: { side: 'sell', percent: 100 } },
		],
		caps: { sessionSpendCapSol: 0.25, perTradeSol: 0.025, maxOpenPositions: 8 },
	},
};

describe('validateStrategySpec — no false positives on working strategies', () => {
	it('accepts the shipped presets with zero errors', () => {
		expect(errorsOf(PRESETS.momentum)).toEqual([]);
		expect(errorsOf(PRESETS.snipe)).toEqual([]);
		expect(validateStrategySpec(validBase()).issues.filter((i) => i.level === 'error')).toEqual([]);
	});
	it('reports filter/exit counts and a SOL denomination', () => {
		const { meta } = validateStrategySpec(PRESETS.momentum);
		expect(meta.filterCount).toBe(3);
		expect(meta.exitCount).toBe(3);
		expect(meta.denominatedQuote).toBe('SOL');
		expect(meta.effectivePerTradeSol).toBe(0.05);
	});
});

describe('validateStrategySpec — structural rejections', () => {
	it('rejects a non-object strategy', () => {
		expect(codesOf(null)).toContain('not_an_object');
		expect(codesOf('nope')).toContain('not_an_object');
	});
	it('rejects a bad scan kind', () => {
		expect(codesOf(validBase({ scan: { kind: 'wat' } }))).toContain('bad_scan_kind');
	});
	it('rejects an empty mintList', () => {
		expect(codesOf(validBase({ scan: { kind: 'mintList', mints: [] } }))).toContain('empty_mint_list');
	});
	it('rejects a non-buy entry side and non-positive size', () => {
		expect(codesOf(validBase({ entry: { side: 'sell', amountSol: 0.05 } }))).toContain('bad_entry_side');
		expect(codesOf(validBase({ entry: { side: 'buy', amountSol: 0 } }))).toContain('bad_amount');
	});
	it('rejects malformed exit actions', () => {
		expect(codesOf(validBase({ exit: [{ if: 'position.pnlPct > 10', do: { side: 'sell', percent: 150 } }] })))
			.toContain('bad_exit_percent');
		expect(codesOf(validBase({ exit: [{ if: 'position.pnlPct > 10', do: { side: 'sell', percent: 50, amountTokens: 1 } }] })))
			.toContain('bad_exit_size');
		expect(codesOf(validBase({ exit: [{ if: 'position.pnlPct > 10', do: { side: 'buy', percent: 50 } }] })))
			.toContain('bad_exit_side');
	});
	it('rejects a zero maxOpenPositions', () => {
		expect(codesOf(validBase({ caps: { maxOpenPositions: 0 } }))).toContain('bad_max_positions');
	});
});

describe('validateStrategySpec — predicate path rejections', () => {
	it('rejects an unknown metric path (typo)', () => {
		expect(codesOf(validBase({ filters: ['holders.totl > 50'] }))).toContain('unknown_path');
	});
	it('rejects position.* used in a filter (never populated at entry)', () => {
		const codes = codesOf(validBase({ filters: ['position.pnlPct > 10'] }));
		expect(codes).toContain('path_unavailable_in_context');
	});
	it('rejects an unparseable predicate', () => {
		expect(codesOf(validBase({ filters: ['garbage'] }))).toContain('unparseable_predicate');
	});
});

describe('validateStrategySpec — impossible thresholds', () => {
	it('rejects a percentage above 100', () => {
		expect(codesOf(validBase({ filters: ['holders.topHolderPct > 100'] }))).toContain('impossible_threshold');
	});
	it('rejects a percentage below 0', () => {
		expect(codesOf(validBase({ filters: ['holders.topHolderPct < 0'] }))).toContain('impossible_threshold');
	});
	it('rejects pnl below -100%', () => {
		expect(codesOf(validBase({ exit: [{ if: 'position.pnlPct < -100', do: { side: 'sell', percent: 100 } }] })))
			.toContain('impossible_threshold');
	});
	it('rejects a fractional value for an integer metric', () => {
		expect(codesOf(validBase({ filters: ['holders.total == 50.5'] }))).toContain('impossible_threshold');
	});
	it('rejects a negative count equality', () => {
		expect(codesOf(validBase({ filters: ['creator.rugCount == -1'] }))).toContain('impossible_threshold');
	});
});

describe('validateStrategySpec — contradiction & cap sanity', () => {
	it('rejects contradictory filters on the same path', () => {
		const codes = codesOf(validBase({ filters: ['holders.total > 100', 'holders.total < 50'] }));
		expect(codes).toContain('contradictory_filters');
	});
	it('rejects a per-trade size larger than the session cap', () => {
		const codes = codesOf(validBase({ entry: { side: 'buy', amountSol: 0.5 }, caps: { sessionSpendCapSol: 0.1 } }));
		expect(codes).toContain('cap_below_per_trade');
	});
});

describe('validateStrategySpec — non-fatal warnings', () => {
	it('warns (does not reject) on an unreachable shadowed exit rule', () => {
		const report = validateStrategySpec(validBase({
			exit: [
				{ if: 'position.pnlPct > 20', do: { side: 'sell', percent: 50 } },
				{ if: 'position.pnlPct > 40', do: { side: 'sell', percent: 100 } },
			],
		}));
		expect(report.issues.some((i) => i.code === 'shadowed_exit' && i.level === 'warning')).toBe(true);
		expect(report.issues.filter((i) => i.level === 'error')).toEqual([]);
	});
	it('warns on an always-true (redundant) filter', () => {
		expect(codesOf(validBase({ filters: ['holders.total >= 0'] }), 'warning')).toContain('redundant_filter');
	});
	it('warns that caps.perTradeSol is ignored when it differs from entry.amountSol', () => {
		expect(codesOf(validBase({ entry: { side: 'buy', amountSol: 0.05 }, caps: { perTradeSol: 0.1, sessionSpendCapSol: 1 } }), 'warning'))
			.toContain('per_trade_ignored');
	});
	it('warns on a non-base58 mint but does not reject', () => {
		const report = validateStrategySpec(validBase({ scan: { kind: 'mintList', mints: ['M1'] } }));
		expect(report.issues.some((i) => i.code === 'malformed_mint' && i.level === 'warning')).toBe(true);
		expect(report.issues.filter((i) => i.level === 'error')).toEqual([]);
	});
});

describe('validateStrategy handler — live mint & quote checks', () => {
	const mintListSpec = validBase({ scan: { kind: 'mintList', mints: [SYNTH_MINT] } });

	it('rejects a SOL strategy targeting a USDC-paired agent coin', async () => {
		const r = await validateStrategy({
			strategy: mintListSpec,
			mintInfo: { [SYNTH_MINT]: { isAgentCoin: true, quoteIsUsdc: true, quoteSymbol: 'USDC' } },
		});
		expect(r.ok).toBe(false);
		expect(r.data.issues.some((i) => i.code === 'quote_asset_mismatch')).toBe(true);
	});

	it('accepts a SOL strategy targeting a SOL-paired agent coin', async () => {
		const r = await validateStrategy({
			strategy: mintListSpec,
			mintInfo: { [SYNTH_MINT]: { isAgentCoin: true, quoteIsUsdc: false, quoteSymbol: 'SOL' } },
		});
		expect(r.ok).toBe(true);
		expect(r.data.issues.some((i) => i.level === 'error')).toBe(false);
	});

	it('rejects a mint that definitively does not exist on-chain', async () => {
		const ctx = { skills: { invoke: async () => ({ ok: false, error: 'mint account not found' }) } };
		const r = await validateStrategy({ strategy: mintListSpec, mintInfo: null }, ctx);
		expect(r.ok).toBe(false);
		expect(r.data.issues.some((i) => i.code === 'mint_not_found')).toBe(true);
	});

	it('downgrades a transient probe failure to a warning (no false rejection)', async () => {
		const ctx = { skills: { invoke: async () => ({ ok: false, error: 'RPC 429 rate limited' }) } };
		const r = await validateStrategy({ strategy: mintListSpec, mintInfo: null }, ctx);
		expect(r.ok).toBe(true);
		expect(r.data.issues.some((i) => i.code === 'mint_unverified' && i.level === 'warning')).toBe(true);
	});

	it('flags a real-but-non-agent coin as info, not an error', async () => {
		const ctx = { skills: { invoke: async () => ({ ok: true, data: { mint: SYNTH_MINT, decimals: 6 } }) } };
		const r = await validateStrategy({ strategy: mintListSpec, mintInfo: null }, ctx);
		expect(r.ok).toBe(true);
		expect(r.data.issues.some((i) => i.code === 'not_agent_coin' && i.level === 'info')).toBe(true);
	});

	it('stays backward-compatible: valid spec returns parsed metadata', async () => {
		const r = await validateStrategy({
			strategy: {
				scan: { kind: 'newTokens' },
				filters: ['holders.total > 10'],
				entry: { side: 'buy', amountSol: 0.05 },
				exit: [{ if: 'position.pnlPct > 100', do: { side: 'sell', percent: 100 } }],
			},
		});
		expect(r.ok).toBe(true);
		expect(r.data.filterCount).toBe(1);
		expect(r.data.exitCount).toBe(1);
	});
});

describe('run/backtest pre-flight gate agrees with validate', () => {
	const broken = validBase({ filters: ['position.pnlPct > 10'] }); // position.* in filter

	it('strategyErrors flags the broken spec', () => {
		expect(strategyErrors(broken).length).toBeGreaterThan(0);
	});

	it('backtestStrategy refuses a semantically-broken spec before replay', async () => {
		const ctx = { skills: { invoke: async () => ({ ok: true, data: {} }) } };
		const r = await backtestStrategy({ strategy: broken, mints: [SYNTH_MINT] }, ctx);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/position/i);
	});

	it('runStrategy throws on a semantically-broken spec', async () => {
		await expect(
			runStrategy({ strategy: broken, durationSec: 5, simulate: true }, { skills: { invoke: async () => ({ ok: true, data: {} }) } }),
		).rejects.toThrow(/invalid strategy/i);
	});
});
