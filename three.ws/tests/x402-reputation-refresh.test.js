import { describe, it, expect } from 'vitest';

import {
	extractReputation,
	evaluateReputation,
} from '../api/_lib/x402/pipelines/reputation-refresh.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';
import { priceFor, x402AmountForTool, isFreeTool } from '../api/_lib/pump-pricing.js';

const rep = (over = {}) => ({
	agent: 'THREEsynthetic1111111111111111111111111111',
	network: 'mainnet',
	feedback: { total: 5, verified: 4, disputed: 0, score_avg: 4.2, score_avg_verified: 4.5 },
	validation: { passed: 2, failed: 0 },
	...over,
});

describe('reputation refresh — JSON-RPC response parsing', () => {
	it('extracts structuredContent from a tools/call body', () => {
		const out = extractReputation({ result: { structuredContent: rep() } });
		expect(out.feedback.total).toBe(5);
		expect(out.validation.passed).toBe(2);
	});

	it('handles a single-element batch array', () => {
		const out = extractReputation([{ result: { structuredContent: rep() } }]);
		expect(out).toBeTruthy();
		expect(out.feedback.verified).toBe(4);
	});

	it('returns null (not throw) on a malformed / error body', () => {
		expect(extractReputation(null)).toBeNull();
		expect(extractReputation({ error: { code: -32000 } })).toBeNull();
		expect(extractReputation({ result: {} })).toBeNull();
		expect(extractReputation({ result: { structuredContent: { error: 'x' } } })).toBeNull();
	});
});

describe('reputation refresh — score + flag evaluation', () => {
	it('uses the verified average when verified feedback exists', () => {
		const e = evaluateReputation(rep({ feedback: { total: 5, verified: 4, disputed: 0, score_avg: 2.0, score_avg_verified: 4.5 } }));
		expect(e.score).toBe(4.5);
		expect(e.flagged).toBe(false);
	});

	it('falls back to the raw average when there is no verified feedback', () => {
		const e = evaluateReputation(rep({ feedback: { total: 4, verified: 0, disputed: 0, score_avg: 4.1, score_avg_verified: 0 } }));
		expect(e.score).toBe(4.1);
		expect(e.flagged).toBe(false);
	});

	it('flags a low verified score once the sample is meaningful', () => {
		const e = evaluateReputation(rep({ feedback: { total: 6, verified: 5, disputed: 0, score_avg: 4.0, score_avg_verified: 2.4 } }));
		expect(e.flagged).toBe(true);
		expect(e.reasons.join(' ')).toMatch(/score/);
	});

	it('does NOT flag a low score below the minimum sample size', () => {
		const e = evaluateReputation(rep({ feedback: { total: 1, verified: 1, disputed: 0, score_avg: 1.0, score_avg_verified: 1.0 } }));
		expect(e.flagged).toBe(false);
	});

	it('flags when a majority of feedback is disputed', () => {
		const e = evaluateReputation(rep({ feedback: { total: 4, verified: 0, disputed: 3, score_avg: 4.8, score_avg_verified: 0 } }));
		expect(e.flagged).toBe(true);
		expect(e.reasons.join(' ')).toMatch(/disputed/);
	});

	it('flags when validation is net-failing', () => {
		const e = evaluateReputation(rep({ feedback: { total: 0, verified: 0, disputed: 0, score_avg: 0, score_avg_verified: 0 }, validation: { passed: 1, failed: 3 } }));
		expect(e.flagged).toBe(true);
		expect(e.reasons.join(' ')).toMatch(/validation/);
	});

	it('does not throw on an empty payload', () => {
		const e = evaluateReputation({});
		expect(e.score).toBe(0);
		expect(e.flagged).toBe(false);
	});
});

describe('reputation refresh — pricing', () => {
	it('prices solana_agent_reputation at $0.001 (1000 atomic)', () => {
		expect(isFreeTool('solana_agent_reputation')).toBe(false);
		expect(priceFor('solana_agent_reputation').amount_usdc).toBe(0.001);
		expect(x402AmountForTool('solana_agent_reputation')).toBe('1000');
	});
});

describe('reputation refresh — registry wiring', () => {
	it('is registered as an enabled, 6h, run()-style self entry', () => {
		const entry = getFullRegistry().find((e) => e.id === 'reputation-score-refresh');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.cooldown_s).toBe(21600);
		expect(entry.pipeline).toBe('self');
		expect(typeof entry.run).toBe('function');
		expect(entry.path).toBe('/api/mcp');
	});
});
