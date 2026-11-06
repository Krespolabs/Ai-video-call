// @vitest-environment jsdom
//
// DOM tests for the shared wallet-reputation UI. The pure scoring engine is
// covered in wallet-reputation.test.js; here we pin that the badge + breakdown
// render the real, server-shaped result correctly and that every state — new,
// populated, and error — is honestly designed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeReputation, PILLARS } from '../api/_lib/trust/wallet-reputation.js';

// Mock the shared fetch layer so the UI module never hits the network.
const apiFetch = vi.fn();
vi.mock('../src/api.js', () => ({ apiFetch: (...a) => apiFetch(...a) }));

const { reputationBadgeHTML, reputationPanelEl } = await import('../src/shared/agent-reputation.js');

const AID = '11111111-2222-4333-8444-555555555555';
const AID2 = '22222222-2222-4333-8444-555555555555';
const AID3 = '33333333-2222-4333-8444-555555555555';
const AID4 = '44444444-2222-4333-8444-555555555555';
const AID5 = '55555555-2222-4333-8444-555555555555';

function endpointShape(inputs, extra = {}) {
	const r = computeReputation(inputs);
	return {
		agent_id: extra.agent_id || AID,
		name: 'Test Agent',
		...r,
		evidence: { wallet: { label: 'Wallet activity', href: 'https://solscan.io/account/x' } },
		guidance: [],
		is_owner: false,
		computed_at: new Date().toISOString(),
		...extra,
	};
}

function jsonResponse(body, ok = true) {
	return { ok, status: ok ? 200 : 500, json: async () => body };
}

beforeEach(() => {
	apiFetch.mockReset();
});

describe('reputationBadgeHTML', () => {
	it('renders a self-hydrating placeholder for a real agent id', () => {
		const html = reputationBadgeHTML(AID);
		expect(html).toContain('rep-badge-slot');
		expect(html).toContain(`data-rep-aid="${AID}"`);
	});

	it('returns empty string for a non-UUID id (no badge on non-agent rows)', () => {
		expect(reputationBadgeHTML('not-a-uuid')).toBe('');
		expect(reputationBadgeHTML('')).toBe('');
	});
});

describe('reputationPanelEl', () => {
	it('renders the score, tier, pillar bars and evidence for an established agent', async () => {
		apiFetch.mockResolvedValueOnce(
			jsonResponse(
				endpointShape({
					ageDays: 220,
					activeDays90: 40,
					externalTipUsd: 1200,
					settledUsd: 3500,
					tipCount: 18,
					distinctTippers: 9,
					confirmedPayments: 24,
					failedPayments: 1,
					forkCount: 5,
					hasOnchainIdentity: true,
					registryAverage: 4.6,
					registryCount: 7,
					validationCount: 2,
					feedbackCount: 5,
				}),
			),
		);
		const el = reputationPanelEl(AID2);
		await new Promise((r) => setTimeout(r, 0));
		const text = el.textContent;
		expect(text).toMatch(/Tenure & consistency/);
		expect(text).toMatch(/Earnings & volume/);
		// Every scoring pillar renders a row (the breakdown is exhaustive).
		expect(el.querySelectorAll('.rep-pillar').length).toBe(PILLARS.length);
		expect(el.querySelector('.rep-ring-num')).toBeTruthy();
		// Evidence link present and points at real chain explorer.
		expect(el.querySelector('.rep-evi-link')?.getAttribute('href')).toContain('solscan.io');
	});

	it('honestly shows a brand-new agent as "new" with no fabricated number', async () => {
		apiFetch.mockResolvedValueOnce(
			jsonResponse(
				endpointShape({
					ageDays: 0,
					activeDays90: 0,
					tipCount: 0,
					distinctTippers: 0,
					confirmedPayments: 0,
					forkCount: 0,
					hasOnchainIdentity: false,
				}),
			),
		);
		const el = reputationPanelEl(AID3);
		await new Promise((r) => setTimeout(r, 0));
		expect(el.querySelector('.rep-ring-num')?.textContent).toBe('—');
		expect(el.textContent).toMatch(/No track record yet/i);
	});

	it('surfaces self-tips and concentration as "what doesn\'t count"', async () => {
		apiFetch.mockResolvedValueOnce(
			jsonResponse(
				endpointShape({
					ageDays: 100,
					tipCount: 40,
					distinctTippers: 1,
					selfTipCount: 12,
					externalTipUsd: 5000,
					settledUsd: 5000,
				}),
			),
		);
		const el = reputationPanelEl(AID4);
		await new Promise((r) => setTimeout(r, 0));
		expect(el.textContent).toMatch(/doesn.t count/i);
		expect(el.textContent).toMatch(/self-tip/i);
	});

	it('renders an actionable error state with retry when the API fails', async () => {
		apiFetch.mockResolvedValueOnce(jsonResponse({}, false));
		const el = reputationPanelEl(AID5);
		await new Promise((r) => setTimeout(r, 0));
		expect(el.querySelector('.rep-retry')).toBeTruthy();
		expect(el.textContent).toMatch(/unavailable/i);
	});
});
