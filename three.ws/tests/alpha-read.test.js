import { describe, it, expect } from 'vitest';
import {
	VERDICTS,
	buildReadPrompt,
	parseReadJson,
	extractNumbers,
	collectSignalNumbers,
	checkGrounding,
	clampSize,
	validateRead,
	deriveGate,
	templatedSpokenLine,
	SIZE_HEADROOM_SOL,
} from '../api/_lib/alpha-read.js';

const SIGNALS = {
	symbol: 'WIDGET',
	name: 'Widget',
	network: 'mainnet',
	age_minutes: 14,
	market_cap_usd: 23000,
	liquidity_sol: 8.4,
	bonding_curve_progress_pct: 41,
	reference_buy_price_impact_pct: 2.3,
	quality_score: 72,
	organic_score: 64,
	smart_money_score: 58,
	smart_money_wallets: 3,
	risk_flags: ['fresh_wallets'],
};

describe('parseReadJson', () => {
	it('parses clean JSON', () => {
		expect(parseReadJson('{"verdict":"watch","conviction":50}')).toEqual({ verdict: 'watch', conviction: 50 });
	});
	it('parses fenced JSON with prose around it', () => {
		const txt = 'Here is my read:\n```json\n{"verdict":"snipe","conviction":80}\n```\nthanks';
		expect(parseReadJson(txt)).toEqual({ verdict: 'snipe', conviction: 80 });
	});
	it('extracts the first balanced object from messy text', () => {
		expect(parseReadJson('blah {"a":1,"b":{"c":2}} trailing')).toEqual({ a: 1, b: { c: 2 } });
	});
	it('returns null on no JSON', () => {
		expect(parseReadJson('no json here')).toBeNull();
		expect(parseReadJson('')).toBeNull();
	});
});

describe('extractNumbers', () => {
	it('handles decimals, thousands separators, and k/m/b suffixes', () => {
		expect(extractNumbers('72.3')).toContain(72.3);
		expect(extractNumbers('$1,234 mcap')).toContain(1234);
		expect(extractNumbers('about 23k market cap')).toContain(23000);
		expect(extractNumbers('3m supply')).toContain(3000000);
	});
});

describe('grounding', () => {
	it('passes a line that only cites real signal numbers', () => {
		const allowed = collectSignalNumbers(SIGNALS, [58]);
		const res = checkGrounding(['Quality is 72 and smart money sits at 58.'], allowed);
		expect(res.ok).toBe(true);
	});
	it('flags a fabricated large figure not present in signals', () => {
		const allowed = collectSignalNumbers(SIGNALS, []);
		const res = checkGrounding(['It already pumped 340% and has $5,000,000 in liquidity.'], allowed);
		expect(res.ok).toBe(false);
		expect(res.suspicious).toContain(5000000);
	});
	it('allows small integer counts without a matching signal', () => {
		const allowed = collectSignalNumbers(SIGNALS, []);
		expect(checkGrounding(['Two risk flags worth noting.'], allowed).ok).toBe(true);
	});
});

describe('clampSize', () => {
	it('returns null for non-positive / missing input', () => {
		expect(clampSize(null, {})).toBeNull();
		expect(clampSize(0, {})).toBeNull();
		expect(clampSize(-1, {})).toBeNull();
	});
	it('clamps to the per-trade cap', () => {
		expect(clampSize(2, { perTradeSol: 0.5 })).toBe(0.5);
	});
	it('clamps to the remaining daily budget', () => {
		expect(clampSize(1, { dailyBudgetSol: 1, dailySpentSol: 0.8 })).toBeCloseTo(0.2, 6);
	});
	it('clamps to wallet balance minus fee headroom', () => {
		expect(clampSize(5, { balanceSol: 0.1 })).toBeCloseTo(0.1 - SIZE_HEADROOM_SOL, 6);
	});
	it('returns 0 when nothing fits', () => {
		expect(clampSize(1, { balanceSol: SIZE_HEADROOM_SOL })).toBe(0);
	});
});

describe('validateRead', () => {
	const owner = { balanceSol: 1, perTradeSol: 0.5, dailyBudgetSol: 2, dailySpentSol: 0, killSwitch: false, frozen: false };

	it('repairs an invalid verdict to watch and clamps conviction', () => {
		const { read } = validateRead({
			raw: { verdict: 'moon', conviction: 250, spoken_line: 'I like Widget here.' },
			signals: SIGNALS, agentName: 'Sage', owner: true, context: owner,
		});
		expect(read.verdict).toBe('watch');
		expect(read.conviction).toBe(100);
	});

	it('clamps a snipe size to policy for the owner', () => {
		const { read, gate } = validateRead({
			raw: { verdict: 'snipe', conviction: 75, suggested_size_sol: 10, risks: [], spoken_line: 'Clean enough — I take a small position.' },
			signals: SIGNALS, agentName: 'Sage', owner: true, context: owner,
		});
		expect(read.suggested_size_sol).toBe(0.5); // per-trade cap
		expect(gate.can_act).toBe(true);
		expect(gate.size_sol).toBe(0.5);
	});

	it('never suggests a size or action for a non-owner', () => {
		const { read, gate } = validateRead({
			raw: { verdict: 'snipe', conviction: 75, suggested_size_sol: 0.3, spoken_line: 'I would size in here.' },
			signals: SIGNALS, agentName: 'Sage', owner: false, context: {},
		});
		expect(read.suggested_size_sol).toBeNull();
		expect(gate.can_act).toBe(false);
		expect(gate.reason).toBe('not_owner');
	});

	it('replaces a spoken line that voices a fabricated number', () => {
		const { read } = validateRead({
			raw: { verdict: 'snipe', conviction: 70, suggested_size_sol: 0.2, risks: [], spoken_line: 'This already did 340% and has $5,000,000 locked — easy snipe.' },
			signals: SIGNALS, agentName: 'Sage', owner: true, context: owner,
		});
		expect(read.hallucination_guard.ok).toBe(false);
		expect(read.hallucination_guard.line_replaced).toBe(true);
		expect(read.spoken_line).not.toMatch(/5,000,000|340/);
	});

	it('keeps a grounded spoken line intact', () => {
		const line = 'Quality is 72 with 3 reputable wallets in — I take a small position.';
		const { read } = validateRead({
			raw: { verdict: 'snipe', conviction: 70, suggested_size_sol: 0.2, risks: [], spoken_line: line },
			signals: SIGNALS, agentName: 'Sage', owner: true, context: owner,
		});
		expect(read.hallucination_guard.ok).toBe(true);
		expect(read.spoken_line).toBe(line);
	});

	it('blocks the action when the kill switch is on', () => {
		const { gate } = validateRead({
			raw: { verdict: 'snipe', conviction: 80, suggested_size_sol: 0.2, spoken_line: 'Looks good.' },
			signals: SIGNALS, agentName: 'Sage', owner: true, context: { ...owner, killSwitch: true },
		});
		expect(gate.can_act).toBe(false);
		expect(gate.reason).toBe('kill_switch');
	});
});

describe('deriveGate', () => {
	it('is not actionable on watch/pass', () => {
		expect(deriveGate({ owner: true, verdict: 'watch', suggestedSize: null, signals: SIGNALS, context: {} }).can_act).toBe(false);
		expect(deriveGate({ owner: true, verdict: 'pass', suggestedSize: null, signals: SIGNALS, context: {} }).reason).toBe('not_actionable');
	});
});

describe('buildReadPrompt', () => {
	it('embeds the signals and forbids inventing numbers', () => {
		const { system, user } = buildReadPrompt({ agentName: 'Sage', persona: 'cautious', network: 'mainnet', signals: SIGNALS, owner: true });
		expect(system).toMatch(/ONLY use the numbers/i);
		expect(user).toContain('"quality_score": 72');
	});
	it('forbids size suggestions for a non-owner', () => {
		const { system } = buildReadPrompt({ agentName: 'Sage', persona: '', network: 'mainnet', signals: SIGNALS, owner: false });
		expect(system).toMatch(/suggested_size_sol" must be null/i);
	});
});

describe('VERDICTS / templatedSpokenLine', () => {
	it('exposes the three verdicts', () => {
		expect(VERDICTS).toEqual(['snipe', 'watch', 'pass']);
	});
	it('produces a grounded fallback line per verdict', () => {
		expect(templatedSpokenLine('snipe', 'Sage', SIGNALS)).toContain('$WIDGET');
		expect(templatedSpokenLine('pass', 'Sage', SIGNALS)).toMatch(/passing/i);
	});
});
