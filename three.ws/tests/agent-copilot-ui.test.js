// @vitest-environment jsdom
//
// Trading Copilot UI contract — the chat surface that lets a wallet owner talk
// to their agent, see live data as cards, and confirm guarded trades. These
// tests lock the client-side shell that mountTradingCopilot() paints WITHOUT a
// network round-trip: the composer, slash-command palette, per-message actions,
// grounded tool cards, and localStorage persistence. The SSE turn, guarded
// execution, and firewall live in api/agents/copilot.js and are covered
// server-side; here we prove the frontend renders and reacts correctly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountTradingCopilot } from '../src/agent-copilot.js';

function mount(opts = {}) {
	const panel = document.createElement('div');
	document.body.appendChild(panel);
	const handle = mountTradingCopilot({
		panel,
		agentId: opts.agentId || 'agent-test',
		agentName: opts.agentName || 'Swarm 5',
		isOwner: opts.isOwner ?? true,
		getNetwork: () => opts.network || 'mainnet',
		toast: () => {},
		...opts,
	});
	return { panel, handle };
}

beforeEach(() => {
	document.body.innerHTML = '';
	try { localStorage.clear(); } catch { /* noop */ }
});

describe('mountTradingCopilot — owner shell', () => {
	it('renders the composer with a slash hint and send button for the owner', () => {
		const { panel } = mount();
		expect(panel.querySelector('[data-host="input"]')).toBeTruthy();
		expect(panel.querySelector('[data-act="send"]')).toBeTruthy();
		expect(panel.querySelector('[data-host="slash"]')).toBeTruthy();
		expect(panel.querySelector('[data-host="input"]').placeholder).toMatch(/type \/ for commands/i);
	});

	it('locks the copilot for a non-owner with an explanatory note', () => {
		const { panel } = mount({ isOwner: false });
		expect(panel.querySelector('[data-host="input"]')).toBeNull();
		expect(panel.textContent).toMatch(/private to/i);
	});

	it('shows the intro + suggestion chips before any message', () => {
		const { panel } = mount();
		const chips = panel.querySelectorAll('[data-suggest]');
		expect(chips.length).toBeGreaterThan(0);
		expect(panel.textContent).toMatch(/Talk to Swarm 5 to trade/);
	});
});

describe('slash-command palette', () => {
	it('opens a filtered menu when the input starts with "/"', () => {
		const { panel } = mount();
		const input = panel.querySelector('[data-host="input"]');
		input.value = '/p';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const menu = panel.querySelector('[data-host="slash"]');
		expect(menu.hidden).toBe(false);
		const items = [...menu.querySelectorAll('[data-slash]')].map((el) => el.dataset.slash);
		expect(items).toContain('/portfolio');
		expect(items.every((c) => c.startsWith('/p'))).toBe(true);
	});

	it('stays closed for ordinary prose', () => {
		const { panel } = mount();
		const input = panel.querySelector('[data-host="input"]');
		input.value = 'how is my portfolio';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		expect(panel.querySelector('[data-host="slash"]').hidden).toBe(true);
	});

	it('/clear wipes a persisted conversation', () => {
		const key = 'awh.copilot.agent-clear.mainnet';
		localStorage.setItem(key, JSON.stringify({ v: 2, messages: [{ role: 'user', content: 'hi' }], actionLog: [] }));
		const { panel } = mount({ agentId: 'agent-clear' });
		// restored history paints a user bubble
		expect(panel.textContent).toContain('hi');
		const input = panel.querySelector('[data-host="input"]');
		input.value = '/clear';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(localStorage.getItem(key)).toBeNull();
		expect(panel.querySelector('.awh-cop-msg')).toBeNull();
	});
});

describe('persistence + grounded tool cards on restore', () => {
	it('restores prior messages and renders a portfolio card from saved tool data', () => {
		localStorage.setItem('awh.copilot.agent-r.mainnet', JSON.stringify({
			v: 2,
			messages: [
				{ role: 'user', content: "How's my portfolio?" },
				{ role: 'agent', content: 'You hold **0.0041 SOL** across 6 tokens.', tools: [
					{ name: 'get_portfolio', summary: 'Portfolio: 0.0041 SOL, 6 token(s), 0 open position(s)', data: {
						kind: 'portfolio', sol_balance: 0.0041, holdings: [{ mint: 'So11111111111111111111111111111111111111112', ui_amount: 1200, decimals: 6 }], open_positions: [],
					} },
				] },
			],
			actionLog: [],
		}));
		const { panel } = mount({ agentId: 'agent-r' });
		// markdown rendered (bold), not raw asterisks
		expect(panel.querySelector('.awh-cop-md strong')).toBeTruthy();
		expect(panel.textContent).not.toContain('**0.0041 SOL**');
		// grounded portfolio card
		const card = panel.querySelector('.awh-cop-card');
		expect(card).toBeTruthy();
		expect(card.textContent).toMatch(/Portfolio/i);
		expect(card.textContent).toMatch(/0\.0041/);
		// activity disclosure summarises the read
		expect(panel.querySelector('.awh-cop-activity')).toBeTruthy();
		// copy action is present on a settled reply with text
		expect(panel.querySelector('[data-msgact="copy"]')).toBeTruthy();
	});

	it('renders a safety verdict card with a blocking pill', () => {
		localStorage.setItem('awh.copilot.agent-s.mainnet', JSON.stringify({
			v: 2,
			messages: [
				{ role: 'user', content: 'is X safe' },
				{ role: 'agent', content: 'That one is blocked by the firewall.', tools: [
					{ name: 'assess_safety', summary: 'Firewall: BLOCK (12/100)', data: { kind: 'safety', mint: 'MintMintMintMintMintMintMintMintMintMintMi', verdict: 'block', score: 12, reasons: ['Mint authority not revoked'], simulated: true } },
				] },
			],
			actionLog: [],
		}));
		const { panel } = mount({ agentId: 'agent-s' });
		const pill = panel.querySelector('.awh-cop-verdict.is-block');
		expect(pill).toBeTruthy();
		expect(panel.textContent).toMatch(/Mint authority not revoked/);
	});

	it('ignores persisted history from a different storage version', () => {
		localStorage.setItem('awh.copilot.agent-v.mainnet', JSON.stringify({ v: 1, messages: [{ role: 'user', content: 'stale' }] }));
		const { panel } = mount({ agentId: 'agent-v' });
		expect(panel.textContent).not.toContain('stale');
	});
});
