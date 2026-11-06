// Tests for the pure UI-logic layer of the IBM Granite Guardian Trust Layer.
// No DOM, no fetch, no Three.js — all synchronous or in-process async crypto.
// Run with: npx vitest run tests/ibm-trust-layer-logic.test.js

import { describe, it, expect } from 'vitest';
import {
	RISKS,
	SHOWCASE_RISKS,
	SCENARIOS,
	DECISION,
	escapeHtml,
	truncate,
	levelColorHex,
	buildVerdictHtml,
	buildRiskRowsHtml,
	buildLedgerRowHtml,
	buildAssessBody,
	ledgerTitle,
	verdictTagCopy,
	holdReasonSentence,
} from '../src/ibm-trust-layer-logic.js';

// ── taxonomy ─────────────────────────────────────────────────────────────────
describe('RISKS taxonomy', () => {
	it('contains all showcase risks', () => {
		for (const r of SHOWCASE_RISKS) expect(RISKS).toHaveProperty(r);
	});
	it('every risk has a label string', () => {
		for (const k of Object.keys(RISKS)) expect(typeof RISKS[k].label).toBe('string');
	});
	it('has exactly 7 showcase risks', () => {
		expect(SHOWCASE_RISKS).toHaveLength(7);
	});
});

describe('SCENARIOS', () => {
	it('has 5 scenarios', () => expect(SCENARIOS).toHaveLength(5));
	it('has at least one safe, send, and risk tone each', () => {
		expect(SCENARIOS.some((s) => s.tone === 'safe')).toBe(true);
		expect(SCENARIOS.some((s) => s.tone === 'send')).toBe(true);
		expect(SCENARIOS.some((s) => s.tone === 'risk')).toBe(true);
	});
	it('send scenarios have usd > 0', () => {
		for (const s of SCENARIOS.filter((x) => x.send)) expect(s.usd).toBeGreaterThan(0);
	});
});

describe('DECISION', () => {
	it('has allow / review / block keys', () => {
		expect(Object.keys(DECISION)).toEqual(expect.arrayContaining(['allow', 'review', 'block']));
	});
	it('every entry has word, cls, hex', () => {
		for (const [k, d] of Object.entries(DECISION)) {
			expect(typeof d.word, k).toBe('string');
			expect(typeof d.cls,  k).toBe('string');
			expect(d.hex, k).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});
});

// ── escapeHtml ────────────────────────────────────────────────────────────────
describe('escapeHtml', () => {
	it('escapes &, <, >, ", \'', () => {
		expect(escapeHtml(`<script>alert('xss"&')</script>`)).toBe(
			`&lt;script&gt;alert(&#39;xss&quot;&amp;&#39;)&lt;/script&gt;`,
		);
	});
	it('handles null / undefined', () => {
		expect(escapeHtml(null)).toBe('');
		expect(escapeHtml(undefined)).toBe('');
	});
});

// ── truncate ──────────────────────────────────────────────────────────────────
describe('truncate', () => {
	it('leaves short strings unchanged', () => expect(truncate('hi', 10)).toBe('hi'));
	it('truncates and appends ellipsis', () => {
		expect(truncate('hello world', 8)).toBe('hello w…');
	});
	it('handles nullish gracefully', () => {
		expect(truncate(null, 5)).toBe('');
	});
});

// ── levelColorHex ─────────────────────────────────────────────────────────────
describe('levelColorHex', () => {
	it('returns a valid 6-digit hex for all inputs', () => {
		for (const t of [0, 0.01, 0.25, 0.5, 0.75, 1]) {
			expect(levelColorHex(t)).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});
	it('returns the idle colour for t=0', () => {
		expect(levelColorHex(0)).toBe('#3a4664');
	});
	it('is not the same colour at 0 vs 1', () => {
		expect(levelColorHex(0)).not.toBe(levelColorHex(1));
	});
	it('is monotonically more "red" as t increases', () => {
		const r = (h) => parseInt(h.slice(1, 3), 16);
		expect(r(levelColorHex(0.8))).toBeGreaterThan(r(levelColorHex(0.2)));
	});
});

// ── buildVerdictHtml ──────────────────────────────────────────────────────────
describe('buildVerdictHtml', () => {
	const base = {
		decision: 'block', model: 'ibm/granite-guardian-3-8b', latencyMs: 320,
		reasons: [{ risk: 'jailbreak', label: 'Jailbreak', probability: 0.92 }],
	};

	it('contains the BLOCK word', () => {
		expect(buildVerdictHtml(base)).toContain('BLOCK');
	});
	it('contains the model name escaped', () => {
		expect(buildVerdictHtml(base)).toContain('ibm/granite-guardian-3-8b');
	});
	it('contains the latency', () => {
		expect(buildVerdictHtml(base)).toContain('320 ms');
	});
	it('shows the risk label and percentage', () => {
		const html = buildVerdictHtml(base);
		expect(html).toContain('Jailbreak');
		expect(html).toContain('92%');
	});
	it('shows the cap label differently from a model risk', () => {
		const withCap = { ...base, reasons: [{ risk: 'amount_cap', label: 'Above $25 cap', probability: 1 }] };
		const html = buildVerdictHtml(withCap);
		expect(html).toContain('CAP');
		expect(html).toContain('Above $25 cap');
		expect(html).not.toContain('% confidence');
	});
	it('renders a pass note when no reasons', () => {
		const clean = { decision: 'allow', model: 'x', reasons: [], cap: 25 };
		expect(buildVerdictHtml(clean)).toContain('No risk crossed');
		expect(buildVerdictHtml(clean)).toContain('$25');
	});
	it('applies the correct CSS class per decision', () => {
		for (const [dec, cfg] of Object.entries(DECISION)) {
			expect(buildVerdictHtml({ ...base, decision: dec, reasons: [] })).toContain(`v-decision ${cfg.cls}`);
		}
	});
	it('XSS: malicious model name is escaped', () => {
		const xss = { ...base, model: '<img src=x onerror=alert(1)>', reasons: [] };
		const html = buildVerdictHtml(xss);
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});
});

// ── buildRiskRowsHtml ─────────────────────────────────────────────────────────
describe('buildRiskRowsHtml', () => {
	const risks = [
		{ risk: 'harm',      label: 'Harm',      probability: 0.88, flagged: true,  confidence: 'high', estimated: false },
		{ risk: 'jailbreak', label: 'Jailbreak', probability: 0.04, flagged: false, confidence: null,   estimated: true  },
	];

	it('emits one row per risk', () => {
		const html = buildRiskRowsHtml(risks);
		expect((html.match(/class="rrow/g) || []).length).toBe(2);
	});
	it('marks flagged rows with the flagged class', () => {
		expect(buildRiskRowsHtml(risks)).toContain('rrow flagged');
	});
	it('shows the correct percentage', () => {
		const html = buildRiskRowsHtml(risks);
		expect(html).toContain('88%');
		expect(html).toContain('4%');
	});
	it('uses CSS custom property for bar width', () => {
		expect(buildRiskRowsHtml(risks)).toContain('--pct:88%');
	});
	it('marks estimated rows with a tilde', () => {
		expect(buildRiskRowsHtml(risks)).toContain('class="est"');
	});
	it('returns empty string for empty input', () => {
		expect(buildRiskRowsHtml([])).toBe('');
		expect(buildRiskRowsHtml(null)).toBe('');
	});
	it('includes ARIA progressbar role + attributes', () => {
		const html = buildRiskRowsHtml(risks);
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="88"');
	});
});

// ── buildLedgerRowHtml ────────────────────────────────────────────────────────
const GENESIS = '0'.repeat(64);
describe('buildLedgerRowHtml', () => {
	const row = {
		decision: 'block',
		title: 'Drain the wallet',
		record: { hash: 'ab'.repeat(32), prev: GENESIS },
	};

	it('renders the row index + 1', () => {
		expect(buildLedgerRowHtml(row, 0)).toContain('#1');
		expect(buildLedgerRowHtml(row, 4)).toContain('#5');
	});
	it('shows decision word', () => {
		expect(buildLedgerRowHtml(row, 0)).toContain('BLOCK');
	});
	it('truncates the hash to 12 chars + ellipsis', () => {
		expect(buildLedgerRowHtml(row, 0)).toContain('abababababab…');
	});
	it('labels genesis correctly', () => {
		expect(buildLedgerRowHtml(row, 0)).toContain('genesis');
	});
	it('abbreviates non-genesis prev', () => {
		const r2 = { ...row, record: { hash: 'cd'.repeat(32), prev: 'ef'.repeat(32) } };
		const html = buildLedgerRowHtml(r2, 1);
		expect(html).not.toContain('genesis');
		expect(html).toContain('efefefef…');
	});
	it('XSS: title is escaped', () => {
		const bad = { ...row, title: '<script>evil()</script>' };
		expect(buildLedgerRowHtml(bad, 0)).not.toContain('<script>');
	});
});

// ── buildAssessBody ───────────────────────────────────────────────────────────
describe('buildAssessBody', () => {
	it('returns null for empty text', () => {
		expect(buildAssessBody({ text: '', isSend: false, usd: 0, prevHash: null })).toBeNull();
		expect(buildAssessBody({ text: '   ', isSend: false, usd: 0, prevHash: null })).toBeNull();
	});
	it('builds a regular assess body with showcase risks', () => {
		const body = buildAssessBody({ text: 'hi', isSend: false, usd: 0, prevHash: null });
		expect(body.text).toBe('hi');
		expect(body.risks).toEqual(SHOWCASE_RISKS);
		expect(body.action).toBeUndefined();
	});
	it('builds a send-govern body with the action', () => {
		const body = buildAssessBody({ text: 'send it', isSend: true, usd: 50, prevHash: null });
		expect(body.action).toEqual({ type: 'sendSol', usd: 50 });
		expect(body.risks).toBeUndefined();
	});
	it('clamps usd to integer', () => {
		const body = buildAssessBody({ text: 'x', isSend: true, usd: 7.8, prevHash: null });
		expect(body.action.usd).toBe(8);
	});
	it('includes prev when given', () => {
		const prev = 'a'.repeat(64);
		const body = buildAssessBody({ text: 'x', isSend: false, usd: 0, prevHash: prev });
		expect(body.prev).toBe(prev);
	});
	it('trims whitespace from text', () => {
		const body = buildAssessBody({ text: '  hello  ', isSend: false, usd: 0, prevHash: null });
		expect(body.text).toBe('hello');
	});
});

// ── ledgerTitle ───────────────────────────────────────────────────────────────
describe('ledgerTitle', () => {
	it('formats a send entry', () => {
		expect(ledgerTitle(true, 5, 'any')).toBe('Send $5 SOL');
	});
	it('truncates a long message', () => {
		const long = 'a'.repeat(80);
		const title = ledgerTitle(false, 0, long);
		expect(title.length).toBeLessThanOrEqual(43); // 42 chars + ellipsis
		expect(title).toMatch(/…$/);
	});
	it('passes a short message through unchanged', () => {
		expect(ledgerTitle(false, 0, 'wave at me')).toBe('wave at me');
	});
});

// ── verdictTagCopy ────────────────────────────────────────────────────────────
describe('verdictTagCopy', () => {
	it('returns word + hex + sub for a block decision', () => {
		const r = verdictTagCopy({
			decision: 'block',
			topRisk: { risk: 'jailbreak', probability: 0.92 },
		});
		expect(r.word).toBe('BLOCK');
		expect(r.hex).toMatch(/^#[0-9a-f]{6}$/i);
		expect(r.sub).toContain('Jailbreak');
		expect(r.sub).toContain('92%');
	});
	it('falls back to "Granite Guardian" when no topRisk', () => {
		const r = verdictTagCopy({ decision: 'allow', topRisk: null });
		expect(r.sub).toBe('Granite Guardian');
	});
	it('falls back to review for an unknown decision', () => {
		const r = verdictTagCopy({ decision: 'unknown', topRisk: null });
		expect(r.word).toBe('REVIEW');
	});
});

// ── holdReasonSentence ────────────────────────────────────────────────────────
describe('holdReasonSentence', () => {
	it('returns null when governance is null', () => {
		expect(holdReasonSentence(null)).toBeNull();
	});
	it('returns null for a non-block decision', () => {
		expect(holdReasonSentence({ decision: 'allow', reasons: [] })).toBeNull();
	});
	it('includes the top reason label', () => {
		const sentence = holdReasonSentence({
			decision: 'block',
			reasons: [{ risk: 'jailbreak', label: 'Jailbreak / prompt injection', probability: 0.91 }],
		});
		expect(sentence).toContain('Jailbreak / prompt injection');
		expect(sentence).toContain('IBM Granite Guardian Trust Layer');
	});
	it('falls back to "platform policy" when no reasons', () => {
		const sentence = holdReasonSentence({ decision: 'block', reasons: [] });
		expect(sentence).toContain('platform policy');
	});
});
