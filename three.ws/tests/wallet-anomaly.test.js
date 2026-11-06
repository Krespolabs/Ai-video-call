// Unit tests for api/_lib/wallet-anomaly.js — the pure behavioral-anomaly engine.
//
// Covers baseline math, each scoring dimension (size, new-counterparty, velocity,
// off-hours, new-asset), the noisy-OR combination + critical override, the
// low-history widened-tolerance path, sensitivity thresholds, config normalization,
// totality (never throws on garbage), and approve-teaches-the-baseline.

import { describe, it, expect } from 'vitest';
import {
	computeBaseline, scoreOutbound, applyApproval, normalizeAnomalyConfig,
	getAnomalyConfig, summarize, sensitivityPreset, MIN_HISTORY, SENSITIVITY_PRESETS,
} from '../api/_lib/wallet-anomaly.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-06-01T12:00:00Z'); // 12:00 UTC

// Build a history of priced spends to one known address at a steady noon-ish hour.
function history(n, { usd = 5, dest = 'KNOWNaddr1111111111111111111111111111111', asset = 'USDC', startHour = 12 } = {}) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const ms = Date.parse(`2026-05-${String((i % 27) + 1).padStart(2, '0')}T${String(startHour).padStart(2, '0')}:00:00Z`);
		out.push({ usd, destination: dest, asset, category: 'x402', created_at: new Date(ms).toISOString() });
	}
	return out;
}

const KNOWN = 'KNOWNaddr1111111111111111111111111111111';
const NEW = 'NEWaddrZZZZ2222222222222222222222222222222';

describe('computeBaseline', () => {
	it('learns size, counterparties, assets and active hours from history', () => {
		const b = computeBaseline(history(10, { usd: 5 }), T0);
		expect(b.n).toBe(10);
		expect(b.total_events).toBe(10);
		expect(b.usd.max).toBe(5);
		expect(b.usd.mean).toBeCloseTo(5, 5);
		expect(b.counterparties).toContain(KNOWN);
		expect(b.counterparty_count).toBe(1);
		expect(b.assets).toEqual(['USDC']);
		expect(b.active_hours).toEqual([12]);
	});

	it('handles empty / non-array input without throwing', () => {
		expect(computeBaseline([], 0).n).toBe(0);
		expect(computeBaseline(null, 0).n).toBe(0);
		expect(computeBaseline(undefined, 0).counterparties).toEqual([]);
	});

	it('ignores unpriced rows in the usd distribution but keeps their destination', () => {
		const b = computeBaseline([
			{ usd: null, destination: KNOWN, asset: 'SOL', category: 'withdraw', created_at: new Date(T0).toISOString() },
			{ usd: 10, destination: KNOWN, asset: 'USDC', category: 'x402', created_at: new Date(T0).toISOString() },
		], T0);
		expect(b.n).toBe(1);
		expect(b.usd.max).toBe(10);
		expect(b.counterparty_count).toBe(1);
	});
});

describe('scoreOutbound — dimensions', () => {
	const baseline = computeBaseline(history(12, { usd: 10 }), T0); // max $10, known addr, hour 12
	const cfg = normalizeAnomalyConfig({ sensitivity: 'balanced' });
	const calm = { count_1min: 1, count_10min: 1 };

	it('allows a normal spend (known addr, normal size, normal hour) with no factors', () => {
		const v = scoreOutbound({ baseline, config: cfg, action: { usdValue: 8, destination: KNOWN, asset: 'USDC', category: 'x402', atMs: T0 }, recent: calm });
		expect(v.decision).toBe('allow');
		expect(v.factors).toHaveLength(0);
		expect(v.score).toBe(0);
	});

	it('flags an oversized spend (size dimension)', () => {
		const v = scoreOutbound({ baseline, config: cfg, action: { usdValue: 80, destination: KNOWN, asset: 'USDC', category: 'trade', atMs: T0 }, recent: calm });
		const f = v.factors.find((x) => x.key === 'size');
		expect(f).toBeTruthy();
		expect(f.label).toMatch(/largest-ever/);
	});

	it('flags a first-ever destination and treats a high-value new dest as critical → freeze', () => {
		const v = scoreOutbound({ baseline, config: cfg, action: { usdValue: 60, destination: NEW, asset: 'USDC', category: 'x402', atMs: T0 }, recent: calm });
		const f = v.factors.find((x) => x.key === 'new_counterparty');
		expect(f).toBeTruthy();
		expect(v.critical).toBe(true);
		expect(v.decision).toBe('freeze');
	});

	it('flags a hard velocity burst as critical even for a tiny, known-address spend', () => {
		const v = scoreOutbound({ baseline, config: cfg, action: { usdValue: 1, destination: KNOWN, asset: 'USDC', category: 'x402', atMs: T0 }, recent: { count_1min: 10, count_10min: 12 } });
		const f = v.factors.find((x) => x.key === 'velocity');
		expect(f).toBeTruthy();
		expect(f.severity).toBe('critical');
		expect(v.decision).toBe('freeze');
	});

	it('flags activity outside the agent’s usual hours', () => {
		const v = scoreOutbound({ baseline, config: cfg, action: { usdValue: 8, destination: KNOWN, asset: 'USDC', category: 'x402', atMs: T0 + 11 * HOUR }, recent: calm });
		expect(v.factors.some((x) => x.key === 'off_hours')).toBe(true);
	});

	it('flags a never-before-moved asset', () => {
		const v = scoreOutbound({ baseline, config: cfg, action: { usdValue: 8, destination: KNOWN, asset: 'BONKmint', category: 'trade', atMs: T0 }, recent: calm });
		expect(v.factors.some((x) => x.key === 'new_asset')).toBe(true);
	});
});

describe('scoreOutbound — sensitivity', () => {
	const baseline = computeBaseline(history(12, { usd: 10 }), T0);
	// A moderate-but-not-critical signal: ~1.6× the largest spend to a KNOWN address,
	// at an off-hour. Lands the combined score between the strict and relaxed thresholds.
	const action = { usdValue: 16, destination: KNOWN, asset: 'USDC', category: 'trade', atMs: T0 + 11 * HOUR };
	const calm = { count_1min: 1, count_10min: 1 };

	it('strict freezes where relaxed allows the same moderate anomaly', () => {
		const strict = scoreOutbound({ baseline, config: { sensitivity: 'strict' }, action, recent: calm });
		const relaxed = scoreOutbound({ baseline, config: { sensitivity: 'relaxed' }, action, recent: calm });
		expect(strict.threshold).toBe(SENSITIVITY_PRESETS.strict.threshold);
		expect(relaxed.threshold).toBe(SENSITIVITY_PRESETS.relaxed.threshold);
		// Same score, different verdict driven purely by the threshold.
		expect(strict.score).toBe(relaxed.score);
		expect(strict.decision).toBe('freeze');
		expect(relaxed.decision).toBe('allow');
	});

	it('never freezes when the guard is disabled', () => {
		const v = scoreOutbound({ baseline, config: { sensitivity: 'strict', enabled: false }, action: { usdValue: 1000, destination: NEW, category: 'x402', atMs: T0 }, recent: { count_1min: 30, count_10min: 50 } });
		expect(v.decision).toBe('allow');
	});
});

describe('scoreOutbound — low history widens tolerances', () => {
	const thin = computeBaseline(history(2, { usd: 5 }), T0); // < MIN_HISTORY
	const cfg = normalizeAnomalyConfig({ sensitivity: 'balanced' });
	const calm = { count_1min: 1, count_10min: 1 };

	it('marks lowHistory and lets a small first-time spend through', () => {
		const v = scoreOutbound({ baseline: thin, config: cfg, action: { usdValue: 3, destination: NEW, asset: 'USDC', category: 'x402', atMs: T0 }, recent: calm });
		expect(v.lowHistory).toBe(true);
		expect(v.decision).toBe('allow');
	});

	it('still catches a materially large brand-new spend even with thin history', () => {
		const v = scoreOutbound({ baseline: thin, config: cfg, action: { usdValue: 400, destination: NEW, asset: 'USDC', category: 'withdraw', atMs: T0 }, recent: calm });
		expect(v.factors.some((x) => x.key === 'new_counterparty')).toBe(true);
		expect(v.score).toBeGreaterThanOrEqual(0.5);
	});
});

describe('scoreOutbound — totality (never throws)', () => {
	it('returns a safe allow verdict on garbage input', () => {
		for (const bad of [undefined, {}, { action: null }, { baseline: 42, action: 'x', recent: 7 }]) {
			const v = scoreOutbound(bad);
			expect(v.decision === 'allow' || v.decision === 'freeze').toBe(true);
			expect(Array.isArray(v.factors)).toBe(true);
			expect(v.score).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('applyApproval — teaches the baseline', () => {
	it('blesses the destination, raises the size ceiling, and adds the hour so it won’t re-trip', () => {
		const base = computeBaseline(history(12, { usd: 10 }), T0);
		const cfg = normalizeAnomalyConfig({ sensitivity: 'balanced' });
		const action = { usdValue: 60, destination: NEW, asset: 'USDC', category: 'x402', atMs: T0 + 11 * HOUR };

		const before = scoreOutbound({ baseline: base, config: cfg, action, recent: { count_1min: 1, count_10min: 1 } });
		expect(before.decision).toBe('freeze');

		const taught = applyApproval(cfg, { destination: NEW, usd: 60, hour_utc: new Date(action.atMs).getUTCHours() });
		expect(taught.allow_destinations).toContain(NEW);
		expect(taught.size_ceiling_usd).toBe(60);

		const after = scoreOutbound({ baseline: base, config: taught, action, recent: { count_1min: 1, count_10min: 1 } });
		expect(after.decision).toBe('allow');
		expect(after.factors.some((x) => x.key === 'new_counterparty')).toBe(false);
	});

	it('approving a known pattern still leaves velocity protection intact', () => {
		const base = computeBaseline(history(12, { usd: 10 }), T0);
		const taught = applyApproval(normalizeAnomalyConfig({}), { destination: NEW, usd: 60, hour_utc: 12 });
		const v = scoreOutbound({ baseline: base, config: taught, action: { usdValue: 1, destination: NEW, category: 'x402', atMs: T0 }, recent: { count_1min: 12, count_10min: 14 } });
		expect(v.decision).toBe('freeze'); // velocity still trips
	});
});

describe('normalizeAnomalyConfig', () => {
	it('clamps invalid input to safe defaults', () => {
		const c = normalizeAnomalyConfig({ sensitivity: 'bogus', extra_hours: [25, -1, 5, 5], size_ceiling_usd: -3, safe_address: '  ' });
		expect(c.sensitivity).toBe('balanced');
		expect(c.extra_hours).toEqual([5]);
		expect(c.size_ceiling_usd).toBe(null);
		expect(c.safe_address).toBe(null);
		expect(c.enabled).toBe(true);
	});

	it('getAnomalyConfig reads from a meta blob', () => {
		expect(getAnomalyConfig({ anomaly: { sensitivity: 'strict' } }).sensitivity).toBe('strict');
		expect(getAnomalyConfig(null).sensitivity).toBe('balanced');
	});
});

describe('summarize + presets', () => {
	it('summarizes the top factor and counts the rest', () => {
		expect(summarize({ factors: [] })).toMatch(/nothing/i);
		expect(summarize({ factors: [{ label: 'A' }] })).toBe('A');
		expect(summarize({ factors: [{ label: 'A' }, { label: 'B' }] })).toMatch(/\+1 more/);
	});
	it('sensitivityPreset falls back to balanced', () => {
		expect(sensitivityPreset('nope').key).toBe('balanced');
		expect(MIN_HISTORY).toBeGreaterThan(0);
	});
});
