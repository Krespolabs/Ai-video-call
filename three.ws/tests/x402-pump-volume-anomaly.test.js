import { describe, it, expect } from 'vitest';

import {
	summarizeWindowUsd,
	median,
	scoreVolumeAnomaly,
	buildAnomalySignal,
	classifyVolumeAnomaly,
	DEFAULTS,
} from '../api/_lib/x402/pump-volume-anomaly.js';

import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';

// ── pure-unit: summarizeWindowUsd ────────────────────────────────────────────
describe('summarizeWindowUsd', () => {
	const nowMs = 1_750_000_000_000; // fixed epoch for determinism
	const windowSec = 3600;

	function trade(offsetMs, amountUsd) {
		return { timestamp: new Date(nowMs - offsetMs).toISOString(), amountUsd };
	}

	it('sums trades inside the window', () => {
		const trades = [
			trade(100_000, '50'),   // 100s ago — inside
			trade(3_599_000, '20'), // 3599s ago — inside (just)
			trade(3_601_000, '99'), // 3601s ago — outside
		];
		const { usd, count } = summarizeWindowUsd(trades, nowMs, windowSec);
		expect(usd).toBeCloseTo(70);
		expect(count).toBe(2);
	});

	it('returns zero for an empty array', () => {
		const { usd, count } = summarizeWindowUsd([], nowMs, windowSec);
		expect(usd).toBe(0);
		expect(count).toBe(0);
	});

	it('skips trades with null/missing amountUsd', () => {
		const { usd } = summarizeWindowUsd(
			[{ timestamp: new Date(nowMs - 60_000).toISOString(), amountUsd: null }],
			nowMs,
			windowSec,
		);
		expect(usd).toBe(0);
	});

	it('accepts epoch-seconds timestamps', () => {
		const tSec = Math.floor((nowMs - 300_000) / 1000); // 5 min ago, in seconds
		const { usd } = summarizeWindowUsd(
			[{ timestamp: tSec, amountUsd: '42' }],
			nowMs,
			windowSec,
		);
		expect(usd).toBeCloseTo(42);
	});
});

// ── pure-unit: median ─────────────────────────────────────────────────────────
describe('median', () => {
	it('returns 0 for empty', () => expect(median([])).toBe(0));
	it('handles odd-length array', () => expect(median([1, 3, 5])).toBe(3));
	it('handles even-length array', () => expect(median([2, 4, 6, 8])).toBe(5));
	it('ignores non-finite values', () => expect(median([NaN, 4, Infinity])).toBe(4));
});

// ── pure-unit: scoreVolumeAnomaly ────────────────────────────────────────────
describe('scoreVolumeAnomaly', () => {
	function makeSamples(volumes) {
		return volumes.map((v, i) => ({
			mint: `Mint${i}`,
			name: `Token${i}`,
			symbol: `TK${i}`,
			window_usd: v,
			trade_count: Math.round(v / 10),
		}));
	}

	it('flags a 10× outlier as anomaly', () => {
		// median of [10,12,11,13] ≈ 11.5 → ratio ≈ 10×/11.5 < threshold only if top is 115
		const samples = makeSamples([1150, 10, 12, 11, 13]);
		const score = scoreVolumeAnomaly(samples, { ratioThreshold: 3, minUsd: 100 });
		expect(score.anomaly).toBe(true);
		expect(score.mint).toBe('Mint0');
		expect(score.volume_ratio).toBeGreaterThan(3);
	});

	it('does NOT flag a normal-spread distribution', () => {
		const samples = makeSamples([200, 180, 190, 170, 210]);
		const score = scoreVolumeAnomaly(samples, { ratioThreshold: 3, minUsd: 100 });
		expect(score.anomaly).toBe(false);
	});

	it('returns insufficient_active_coins when fewer than 3 coins have volume', () => {
		const samples = makeSamples([0, 0, 500]);
		const score = scoreVolumeAnomaly(samples, { ratioThreshold: 3, minUsd: 100 });
		expect(score.anomaly).toBe(false);
		expect(score.reason).toBe('insufficient_active_coins');
	});

	it('respects minUsd — tiny absolute volume is not an anomaly', () => {
		const samples = makeSamples([30, 0.5, 0.8, 0.9, 1.0]); // ratio huge but $30 < $250 default
		const score = scoreVolumeAnomaly(samples, { ratioThreshold: 3, minUsd: 250 });
		expect(score.anomaly).toBe(false);
	});

	it('carries trade_count of the top coin', () => {
		const samples = makeSamples([1000, 100, 110, 90, 105]);
		const score = scoreVolumeAnomaly(samples, { ratioThreshold: 3, minUsd: 100 });
		expect(score.trade_count).toBeGreaterThan(0);
	});
});

// ── pure-unit: buildAnomalySignal ────────────────────────────────────────────
describe('buildAnomalySignal', () => {
	it('returns bullish + high conviction for ratio > 5', () => {
		const score = {
			anomaly: true, mint: 'MintABC', symbol: 'XYZ', name: 'XYZ Token',
			volume_ratio: 8.5, top_window_usd: 4200, baseline_usd: 494, candidates: 20, active: 18,
		};
		const sig = buildAnomalySignal(score);
		expect(sig.signal).toBe('bullish');
		expect(sig.conviction).toBe('high');
		expect(sig.confidence).toBeGreaterThan(0.8);
		expect(sig.headline).toMatch(/8\.5/);
	});

	it('returns bullish + normal conviction for ratio 3–5', () => {
		const score = {
			anomaly: true, mint: 'MintDEF', symbol: 'ABC', name: 'ABC Token',
			volume_ratio: 4.1, top_window_usd: 1500, baseline_usd: 365, candidates: 15, active: 12,
		};
		const sig = buildAnomalySignal(score);
		expect(sig.signal).toBe('bullish');
		expect(sig.conviction).toBe('normal');
	});

	it('returns neutral when no anomaly detected', () => {
		const score = {
			anomaly: false, mint: null, symbol: null, volume_ratio: 1.2,
			candidates: 20, active: 18,
		};
		const sig = buildAnomalySignal(score);
		expect(sig.signal).toBe('neutral');
		expect(sig.conviction).toBe('none');
		expect(sig.confidence).toBe(0.5);
	});

	it('returns neutral with appropriate reason for insufficient coins', () => {
		const score = {
			anomaly: false, reason: 'insufficient_active_coins', candidates: 2, active: 1,
		};
		const sig = buildAnomalySignal(score);
		expect(sig.signal).toBe('neutral');
		expect(sig.rationale).toMatch(/Too few active coins/);
	});
});

// ── classifyVolumeAnomaly: oracle signal shape ────────────────────────────────
describe('classifyVolumeAnomaly', () => {
	it('tags high-conviction anomaly when ratio > 5', () => {
		const raw = {
			anomaly: true, mint: 'MintHC', volume_ratio: 7.3,
			signal: 'bullish', headline: 'spike detected', confidence: 0.88,
			token_symbol: 'HC', top_window_usd: 9000, baseline_usd: 1232,
		};
		const cls = classifyVolumeAnomaly(raw);
		expect(cls.anomaly).toBe(true);
		expect(cls.conviction).toBe('high');
		expect(cls.confidence).toBeGreaterThanOrEqual(0.85);
		expect(cls.topic).toBe('pump_volume_anomaly');
		expect(cls.mint).toBe('MintHC');
	});

	it('tags normal conviction for ratio 3–5', () => {
		const raw = {
			anomaly: true, mint: 'MintN', volume_ratio: 3.8,
			signal: 'bullish', confidence: 0.72,
		};
		const cls = classifyVolumeAnomaly(raw);
		expect(cls.conviction).toBe('normal');
	});

	it('tags none when no anomaly', () => {
		const raw = { anomaly: false, mint: null, volume_ratio: 1.1, signal: 'neutral', confidence: 0.5 };
		const cls = classifyVolumeAnomaly(raw);
		expect(cls.conviction).toBe('none');
		expect(cls.anomaly).toBe(false);
	});

	it('handles null/empty input gracefully', () => {
		const cls = classifyVolumeAnomaly(null);
		expect(cls.anomaly).toBe(false);
		expect(cls.conviction).toBe('none');
		expect(cls.topic).toBe('pump_volume_anomaly');
	});
});

// ── registry integration ──────────────────────────────────────────────────────
describe('autonomous registry — pump-volume-anomaly entry', () => {
	const entry = getSelfRegistry().find((e) => e.id === 'pump-volume-anomaly');

	it('exists and is enabled', () => {
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
	});

	it('is oracle pipeline, POST to crypto-intel, 300s cooldown, priority 88', () => {
		expect(entry.pipeline).toBe('oracle');
		expect(entry.method).toBe('POST');
		expect(entry.path).toBe('/api/x402/crypto-intel');
		expect(entry.body).toEqual({ topic: 'pump_volume_anomaly' });
		expect(entry.cooldown_s).toBe(300);
		expect(entry.priority).toBe(88);
	});

	it('extractSignal on a high-conviction anomaly response returns correct shape', () => {
		const raw = {
			topic: 'pump_volume_anomaly', anomaly: true,
			mint: 'SomeMint1111', volume_ratio: 6.2,
			signal: 'bullish', confidence: 0.9,
			token_symbol: 'SPIKE', top_window_usd: 5000, baseline_usd: 806,
		};
		const sig = entry.extractSignal(raw);
		expect(sig.anomaly).toBe(true);
		expect(sig.conviction).toBe('high');
		expect(sig.mint).toBe('SomeMint1111');
		expect(sig.volume_ratio).toBe(6.2);
		expect(sig.topic).toBe('pump_volume_anomaly');
	});

	it('extractSignal on a no-anomaly response returns conviction=none', () => {
		const raw = {
			topic: 'pump_volume_anomaly', anomaly: false,
			mint: null, volume_ratio: 1.4,
			signal: 'neutral', confidence: 0.5,
		};
		const sig = entry.extractSignal(raw);
		expect(sig.anomaly).toBe(false);
		expect(sig.conviction).toBe('none');
	});
});
