// @vitest-environment jsdom
//
// DOM smoke tests for the embed SkillPaymentModal's UX/accessibility behavior:
// it reveals with the is-open class (drives the fade/scale transition), Escape
// dismisses it (resolving false), and a stray keypress does not. These guard the
// keyboard/dismiss contract added for the payment flow. Wallet/on-chain steps
// are out of scope here (they require a wallet + Solana SDK).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SkillPaymentModal } from '../src/payment-modal.js';

function nextFrame() {
	return new Promise((r) => requestAnimationFrame(() => r()));
}

const PAYLOAD = {
	skill: 'translate-text',
	price: { amount: '10000', currency_mint: 'mint', chain: 'solana' },
};

describe('SkillPaymentModal', () => {
	let modal;

	beforeEach(() => {
		document.body.innerHTML = '';
		modal = new SkillPaymentModal(document.body, 'agent-123');
	});

	it('injects a hidden, accessible dialog on construction', () => {
		const overlay = document.querySelector('.skill-pay-overlay');
		expect(overlay).toBeTruthy();
		expect(overlay.hasAttribute('hidden')).toBe(true);
		const box = overlay.querySelector('.skill-pay-box');
		expect(box.getAttribute('role')).toBe('dialog');
		expect(box.getAttribute('aria-modal')).toBe('true');
	});

	it('reveals with the is-open class and renders the skill + amount', async () => {
		modal.show(PAYLOAD);
		await nextFrame();
		const overlay = document.querySelector('.skill-pay-overlay');
		expect(overlay.hasAttribute('hidden')).toBe(false);
		expect(overlay.classList.contains('is-open')).toBe(true);
		expect(document.querySelector('.skill-pay-skill').textContent).toBe('translate-text');
		expect(document.querySelector('.skill-pay-amount').textContent).toContain('USDC');
	});

	it('resolves false and starts closing when Escape is pressed', async () => {
		const result = modal.show(PAYLOAD);
		await nextFrame();
		const overlay = document.querySelector('.skill-pay-overlay');
		overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await expect(result).resolves.toBe(false);
		// The fade-out begins immediately (is-open removed); display:none follows the transition.
		expect(overlay.classList.contains('is-open')).toBe(false);
	});

	it('resolves false when the backdrop is clicked', async () => {
		const result = modal.show(PAYLOAD);
		await nextFrame();
		const overlay = document.querySelector('.skill-pay-overlay');
		overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await expect(result).resolves.toBe(false);
	});

	it('does not dismiss on an unrelated keypress', async () => {
		const result = modal.show(PAYLOAD);
		await nextFrame();
		const overlay = document.querySelector('.skill-pay-overlay');
		overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
		const settled = await Promise.race([result, Promise.resolve('pending')]);
		expect(settled).toBe('pending');
		expect(overlay.classList.contains('is-open')).toBe(true);
	});

	it('restores focus to the previously focused element on close', async () => {
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const result = modal.show(PAYLOAD);
		await nextFrame();
		document
			.querySelector('.skill-pay-overlay')
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await result;
		expect(document.activeElement).toBe(trigger);
	});
});
