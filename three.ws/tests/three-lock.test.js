// @vitest-environment jsdom
//
// Unit tests for the $THREE in-place lock UI (src/three-lock.js) and the headers
// helper on src/three-access.js. These prove the five rendered states, the access
// → state mapping, the "no dead button" rule (pay/use-free only when a handler is
// wired), the handler wiring (retry / use-free / pay / get-three), and that a
// gated request carries no tier-pass header when none is cached. DOM-only; no
// network — the live endpoint is covered by the api/_lib/three-access registry
// tests and the forge-high-gate HTTP tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderLock, lockStateFromAccess } from '../src/three-lock.js';
import { attachTierPass } from '../src/three-access.js';

function host() {
	const el = document.createElement('div');
	document.body.appendChild(el);
	return el;
}

const INELIGIBLE = {
	feature: 'forge.high',
	label: 'High-quality generation (200k poly + PBR)',
	why: 'The High tier spends real GPU/vendor budget.',
	eligible: false,
	required: { level: 1, id: 'bronze', label: 'Bronze' },
	held: { level: 0, id: 'member', label: 'Member', usd: 0 },
	reason: 'insufficient_tier',
	pay_per_use: { action: 'forge.high', usd: 0.5 },
};

const ELIGIBLE = {
	feature: 'forge.high',
	label: 'High-quality generation',
	eligible: true,
	required: { level: 1, id: 'bronze', label: 'Bronze' },
	held: { level: 2, id: 'silver', label: 'Silver', usd: 120 },
	reason: 'eligible',
	pay_per_use: { action: 'forge.high', usd: 0.5 },
};

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('lockStateFromAccess', () => {
	it('maps an eligible payload to the unlocked state', () => {
		const s = lockStateFromAccess(ELIGIBLE);
		expect(s.eligible).toBe(true);
		expect(s.tier).toEqual(ELIGIBLE.held);
	});

	it('maps an ineligible payload to a locked state with pay-per-use', () => {
		const s = lockStateFromAccess(INELIGIBLE);
		expect(s.eligible).toBeUndefined();
		expect(s.reason).toBe('insufficient_tier');
		expect(s.required.label).toBe('Bronze');
		expect(s.payPerUse).toEqual({ action: 'forge.high', usd: 0.5 });
	});

	it('maps a null payload (network failure) to the error state', () => {
		expect(lockStateFromAccess(null)).toEqual({ error: true });
	});

	it('merges extra handlers/urls through', () => {
		const onUseFree = () => {};
		const s = lockStateFromAccess(INELIGIBLE, { getThreeUrl: '/three-token', onUseFree });
		expect(s.getThreeUrl).toBe('/three-token');
		expect(s.onUseFree).toBe(onUseFree);
	});
});

describe('renderLock — states', () => {
	it('loading renders a skeleton + an SR status, no overlay card', () => {
		const el = host();
		renderLock(el, { loading: true });
		expect(el.hidden).toBe(false);
		expect(el.querySelector('.tl-card--skel')).toBeTruthy();
		expect(el.querySelector('[role="status"]').textContent).toMatch(/checking/i);
	});

	it('clear empties + hides the host', () => {
		const el = host();
		renderLock(el, { loading: true });
		renderLock(el, { clear: true });
		expect(el.hidden).toBe(true);
		expect(el.innerHTML).toBe('');
	});

	it('unlocked renders a ribbon tinted by tier (silver)', () => {
		const el = host();
		renderLock(el, { eligible: true, tier: { id: 'silver', label: 'Silver' } });
		const ribbon = el.querySelector('.tl-ribbon');
		expect(ribbon).toBeTruthy();
		expect(ribbon.classList.contains('tl-silver')).toBe(true);
		expect(ribbon.textContent).toMatch(/Unlocked · Silver/);
		expect(el.querySelector('.tl-card--lock')).toBeNull();
	});

	it('locked (insufficient_tier) shows required tier, held line, progress + Get $THREE', () => {
		const el = host();
		renderLock(el, lockStateFromAccess(INELIGIBLE, { getThreeUrl: '/three-token' }));
		const card = el.querySelector('.tl-card--lock');
		expect(card).toBeTruthy();
		expect(card.getAttribute('role')).toBe('group');
		expect(card.textContent).toMatch(/Requires\s*Bronze/);
		expect(card.textContent).toMatch(/You hold\s*Member/);
		const get = el.querySelector('[data-tl-get]');
		expect(get.tagName).toBe('A');
		expect(get.getAttribute('href')).toBe('/three-token');
		expect(el.querySelector('.tl-prog')).toBeTruthy();
	});

	it('reason=sign_in shows the sign-in sub + a working Sign in link, no progress', () => {
		const el = host();
		renderLock(el, {
			required: { level: 1, id: 'bronze', label: 'Bronze' },
			held: { level: 0, id: 'member', label: 'Member' },
			reason: 'sign_in',
		});
		expect(el.querySelector('.tl-sub').textContent).toMatch(/sign in/i);
		expect(el.querySelector('a[href="/login"]')).toBeTruthy();
		expect(el.querySelector('.tl-prog')).toBeNull();
	});

	it('reason=link_wallet shows a Link a wallet link', () => {
		const el = host();
		renderLock(el, {
			required: { level: 1, id: 'bronze', label: 'Bronze' },
			held: { level: 0, id: 'member', label: 'Member' },
			reason: 'link_wallet',
		});
		expect(el.querySelector('.tl-sub').textContent).toMatch(/link a solana wallet/i);
		expect(el.querySelector('a[href*="wallets"]')).toBeTruthy();
	});

	it('error renders an alert and a wired Retry button', () => {
		const el = host();
		const onRetry = vi.fn();
		renderLock(el, { error: true, onRetry });
		const alert = el.querySelector('[role="alert"]');
		expect(alert.textContent).toMatch(/couldn.t check access/i);
		el.querySelector('[data-tl-retry]').click();
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it('error without an onRetry drops the dead Retry button', () => {
		const el = host();
		renderLock(el, { error: true });
		expect(el.querySelector('[data-tl-retry]')).toBeNull();
	});
});

describe('renderLock — no dead buttons & wiring', () => {
	it('omits Pay-per-use when no handler is supplied (no dead button)', () => {
		const el = host();
		renderLock(el, lockStateFromAccess(INELIGIBLE)); // payPerUse present, no handler
		expect(el.querySelector('[data-tl-pay]')).toBeNull();
	});

	it('renders + wires Pay-per-use when a handler is supplied', () => {
		const el = host();
		const onPayPerUse = vi.fn();
		renderLock(el, lockStateFromAccess(INELIGIBLE, { onPayPerUse }));
		const pay = el.querySelector('[data-tl-pay]');
		expect(pay).toBeTruthy();
		expect(pay.textContent).toMatch(/\$0\.50 per generation/);
		pay.click();
		expect(onPayPerUse).toHaveBeenCalledWith({ action: 'forge.high', usd: 0.5 });
	});

	it('wires Use-a-free-tier and Get $THREE handlers', () => {
		const el = host();
		const onUseFree = vi.fn();
		const onGetThree = vi.fn();
		renderLock(el, lockStateFromAccess(INELIGIBLE, { onUseFree, onGetThree, useFreeLabel: 'Use Standard (free)' }));
		const free = el.querySelector('[data-tl-free]');
		expect(free.textContent).toBe('Use Standard (free)');
		free.click();
		expect(onUseFree).toHaveBeenCalledOnce();
		const get = el.querySelector('[data-tl-get]');
		get.dispatchEvent(new window.Event('click', { cancelable: true, bubbles: true }));
		expect(onGetThree).toHaveBeenCalledOnce();
	});

	it('escapes untrusted strings in the locked card', () => {
		const el = host();
		renderLock(el, {
			required: { level: 1, id: 'bronze', label: '<img src=x>' },
			held: { level: 0, id: 'member', label: 'Member' },
			reason: 'insufficient_tier',
			label: '<script>alert(1)</script>',
		});
		expect(el.querySelector('img')).toBeNull();
		expect(el.querySelector('script')).toBeNull();
	});

	it('a missing target is a safe no-op', () => {
		expect(() => renderLock(null, { loading: true })).not.toThrow();
		expect(() => renderLock('#nope', { loading: true })).not.toThrow();
	});
});

describe('attachTierPass', () => {
	it('returns the headers object unchanged when no pass is cached', () => {
		const h = { 'content-type': 'application/json' };
		const out = attachTierPass(h);
		expect(out).toBe(h);
		expect(out['x-three-tier-pass']).toBeUndefined();
	});

	it('defaults to a fresh object when called with no args', () => {
		expect(attachTierPass()).toEqual({});
	});
});
