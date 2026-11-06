// @vitest-environment jsdom
//
// Agent Wallet hub — Pay tab UI. Mounts the real tab against a mocked x402 pay
// client and asserts the designed states: empty activity, bazaar discover,
// service cards, the preview confirm card, and the funding-aware insufficient
// state that routes to Deposit instead of attempting a doomed payment.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchBazaarServices = vi.fn();
const previewX402 = vi.fn();
const payX402Stream = vi.fn();
const fetchAgentUsdc = vi.fn();
const fetchX402Activity = vi.fn();

vi.mock('../src/agent-x402-pay.js', () => ({
	searchBazaarServices: (...a) => searchBazaarServices(...a),
	previewX402: (...a) => previewX402(...a),
	payX402Stream: (...a) => payX402Stream(...a),
	fetchAgentUsdc: (...a) => fetchAgentUsdc(...a),
	fetchX402Activity: (...a) => fetchX402Activity(...a),
}));

await import('../src/agent-wallet-hub/tabs/pay.js');
const { getRegisteredTabs } = await import('../src/agent-wallet-hub/registry.js');
const payTab = getRegisteredTabs().find((t) => t.id === 'pay');

function makeCtx(overrides = {}) {
	return {
		agentId: 'agent-1',
		agent: { id: 'agent-1', name: 'Tester' },
		isOwner: true,
		network: 'mainnet',
		getNetwork: () => 'mainnet',
		onNetworkChange: () => () => {},
		escapeHtml: (s) =>
			String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
		shortAddress: (a, h = 4, t = 4) => (!a ? '' : a.length <= h + t + 1 ? a : `${a.slice(0, h)}…${a.slice(-t)}`),
		copyToClipboard: vi.fn(async () => true),
		toast: vi.fn(),
		openTab: vi.fn(),
		...overrides,
	};
}

const SOLANA_SERVICE = {
	type: 'http',
	resource: 'https://api.example.com/intel',
	serviceName: 'Crypto Intel',
	description: 'Live market intelligence',
	method: 'GET',
	input: { type: 'http', method: 'GET' },
	accepts: [
		{ family: 'solana', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', priceLabel: '0.05 USDC', amountAtomic: '50000' },
	],
	minPriceLabel: '0.05 USDC',
};

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	searchBazaarServices.mockReset();
	previewX402.mockReset();
	payX402Stream.mockReset();
	fetchAgentUsdc.mockReset();
	fetchX402Activity.mockReset();
	document.body.innerHTML = '';
});

function mountTab(ctx = makeCtx()) {
	const panel = document.createElement('div');
	document.body.appendChild(panel);
	const inst = payTab.mount({ panel, ctx });
	return { panel, inst, ctx };
}

describe('Pay tab — discovery + activity', () => {
	it('registers as an owner-only tab', () => {
		expect(payTab).toBeTruthy();
		expect(payTab.ownerOnly).toBe(true);
	});

	it('shows the empty payment-activity state when there is no history', async () => {
		fetchX402Activity.mockResolvedValue([]);
		const { panel, inst } = mountTab();
		inst.onShow();
		await tick();
		expect(panel.textContent).toMatch(/No payments yet/i);
		expect(panel.querySelector('[data-form="search"]')).toBeTruthy();
	});

	it('renders Solana-payable service cards from a search', async () => {
		fetchX402Activity.mockResolvedValue([]);
		searchBazaarServices.mockResolvedValue({ resources: [SOLANA_SERVICE], count: 1, errors: [] });
		const { panel, inst } = mountTab();
		inst.onShow();
		const form = panel.querySelector('[data-form="search"]');
		const input = panel.querySelector('[data-input="query"]');
		input.value = 'intel';
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await tick();
		expect(searchBazaarServices).toHaveBeenCalled();
		expect(panel.querySelector('.awh-svc-name')?.textContent).toContain('Crypto Intel');
		expect(panel.textContent).toContain('0.05 USDC');
	});

	it('renders a payment-activity row from real custody history', async () => {
		fetchX402Activity.mockResolvedValue([
			{
				id: '10',
				usd: 0.05,
				destination: 'PayToooooAddress1111111111111111111111111',
				signature: 'Sig1111111111111111111111111111111111111111',
				explorer: 'https://solscan.io/tx/Sig111',
				network: 'mainnet',
				status: 'confirmed',
				created_at: new Date().toISOString(),
				meta: { service: 'Crypto Intel', url: 'https://api.example.com/intel' },
			},
		]);
		const { panel, inst } = mountTab();
		inst.onShow();
		await tick();
		expect(panel.querySelector('.awh-act2-svc')?.textContent).toContain('Crypto Intel');
		expect(panel.textContent).toContain('$0.05');
	});
});

describe('Pay tab — preview + funding-aware', () => {
	it('shows the price and a Pay button when the agent can afford it', async () => {
		fetchX402Activity.mockResolvedValue([]);
		searchBazaarServices.mockResolvedValue({ resources: [SOLANA_SERVICE], count: 1, errors: [] });
		previewX402.mockResolvedValue({
			ok: true,
			requires_payment: true,
			payable: true,
			price_usdc: 0.05,
			payTo: 'PayToooooAddress1111111111111111111111111',
			asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
			method: 'GET',
			resource: { url: 'https://api.example.com/intel', serviceName: 'Crypto Intel' },
		});
		fetchAgentUsdc.mockResolvedValue({ address: 'Agent11111111111111111111111111111111111111', usdc: 1.0, sol: 0.1 });

		const { panel, inst } = mountTab();
		inst.onShow();
		const form = panel.querySelector('[data-form="search"]');
		panel.querySelector('[data-input="query"]').value = 'intel';
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await tick();
		panel.querySelector('[data-act="select"]').dispatchEvent(new Event('click', { bubbles: true }));
		await tick();
		await tick();

		expect(previewX402).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: 'agent-1', url: 'https://api.example.com/intel', method: 'GET' }),
		);
		const payBtn = panel.querySelector('[data-act="pay"]');
		expect(payBtn).toBeTruthy();
		expect(payBtn.disabled).toBe(false);
		expect(panel.textContent).toMatch(/0\.05/);
	});

	it('blocks payment and routes to Deposit when USDC is insufficient', async () => {
		fetchX402Activity.mockResolvedValue([]);
		searchBazaarServices.mockResolvedValue({ resources: [SOLANA_SERVICE], count: 1, errors: [] });
		previewX402.mockResolvedValue({
			ok: true,
			requires_payment: true,
			payable: true,
			price_usdc: 0.05,
			payTo: 'PayToooooAddress1111111111111111111111111',
			method: 'GET',
			resource: { url: 'https://api.example.com/intel', serviceName: 'Crypto Intel' },
		});
		fetchAgentUsdc.mockResolvedValue({ address: 'Agent11111111111111111111111111111111111111', usdc: 0.01, sol: 0.1 });

		const ctx = makeCtx();
		const { panel, inst } = mountTab(ctx);
		inst.onShow();
		const form = panel.querySelector('[data-form="search"]');
		panel.querySelector('[data-input="query"]').value = 'intel';
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await tick();
		panel.querySelector('[data-act="select"]').dispatchEvent(new Event('click', { bubbles: true }));
		await tick();
		await tick();

		expect(panel.textContent).toMatch(/Fund the wallet/i);
		const payBtn = panel.querySelector('[data-act="pay"]');
		expect(payBtn.disabled).toBe(true);
		// The payment must never be attempted when funds are short.
		expect(payX402Stream).not.toHaveBeenCalled();

		panel.querySelector('[data-act="fund"]').dispatchEvent(new Event('click', { bubbles: true }));
		expect(ctx.openTab).toHaveBeenCalledWith('deposit');
	});

	it('surfaces an unpayable (non-Solana) service as a clear, recoverable state', async () => {
		fetchX402Activity.mockResolvedValue([]);
		searchBazaarServices.mockResolvedValue({ resources: [SOLANA_SERVICE], count: 1, errors: [] });
		previewX402.mockResolvedValue({
			ok: true,
			requires_payment: true,
			payable: false,
			code: 'no_solana_accept',
			networks: ['eip155:8453'],
		});
		fetchAgentUsdc.mockResolvedValue({ address: 'Agent1', usdc: 1, sol: 0.1 });

		const { panel, inst } = mountTab();
		inst.onShow();
		const form = panel.querySelector('[data-form="search"]');
		panel.querySelector('[data-input="query"]').value = 'intel';
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await tick();
		panel.querySelector('[data-act="select"]').dispatchEvent(new Event('click', { bubbles: true }));
		await tick();
		await tick();

		expect(panel.textContent).toMatch(/only accepts/i);
		expect(panel.querySelector('[data-act="pay"]')).toBeFalsy();
	});
});
