/**
 * onchain-primer.js — the "before you go on-chain" explainer + setup wizard.
 *
 * three.ws is free to browse, build and preview. The moment a user opts into a
 * *money* action — launching a coin, tipping a dancer, deploying on-chain,
 * withdrawing earnings — they hit terms that mean nothing to a newcomer: wallet,
 * USDC, fees. This module is the ladder over that wall: a plain-language
 * explainer followed by a guided, three-step setup that reuses the flows we
 * already ship (the site sign-in and the Add-funds overlay). It invents no new
 * auth and never touches the free core — it only runs when a caller asks for it.
 *
 * Usage (gate a crypto action):
 *
 *   import { ensureOnchainPrimer } from '/src/shared/onchain-primer.js';
 *   if (!(await ensureOnchainPrimer({ action: 'launch-token' }))) return;
 *   // …proceed with the on-chain action: the user is educated + wallet-ready.
 *
 * Returns a Promise<boolean>: true when the user is ready to transact (already
 * crypto-ready, or they connected a wallet through the wizard), false when they
 * backed out before connecting — in which case the caller should abort cleanly.
 *
 * Returning users who already have a wallet/session are never nagged: the gate
 * resolves true instantly with no modal. The explainer is for first-timers.
 */

import { Modal } from './modal.js';
import { signInWithWallet } from '../wallet-auth.js';
import { getWalletState } from '../erc8004/agent-registry.js';
import { showAddFunds } from './add-funds.js';

const DONE_KEY = 'tws:onchain-primer:done';
const AUTH_HINT_KEY = '3dagent:auth-hint';

// Recommended wallets — free browser extensions. Phantom leads (Solana-native,
// where money lands on three.ws); MetaMask covers EVM users. Both inject a
// provider the site sign-in can use.
const WALLETS = [
	{ name: 'Phantom', href: 'https://phantom.app/download', note: 'Solana · recommended' },
	{ name: 'MetaMask', href: 'https://metamask.io/download/', note: 'Multi-chain' },
];

// Per-action framing for the opening line. Keeps the explainer honest about why
// it appeared without changing the (universal) lesson that follows.
const ACTIONS = {
	'launch-token': 'Launching a coin for your agent is an on-chain action.',
	monetize: 'Earning from your agents means money moves on-chain.',
	tip: 'Tipping sends a real micro-payment on-chain.',
	deploy: 'Deploying your agent on-chain registers it on a public network.',
	withdraw: 'Withdrawing your earnings sends them to a wallet you control.',
	default: 'This is an on-chain action — it moves real money.',
};

function escHtml(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * Has the user already crossed the on-chain threshold? Synchronous and cheap so
 * gating a crypto click never adds latency. We treat as ready: anyone who
 * finished this wizard before, anyone signed in via wallet, or anyone with a
 * live injected-wallet connection this session. The action itself still does
 * real auth — this check only decides whether to *teach*.
 */
export function isOnchainReady() {
	try {
		if (localStorage.getItem(DONE_KEY) === '1') return true;
		const raw = localStorage.getItem(AUTH_HINT_KEY);
		if (raw) {
			const hint = JSON.parse(raw);
			if (hint && hint.authed) return true;
		}
	} catch {
		/* localStorage may be unavailable (private mode) — fall through */
	}
	try {
		if (getWalletState().address) return true;
	} catch {
		/* registry not initialized — fall through */
	}
	return false;
}

function markDone() {
	try {
		localStorage.setItem(DONE_KEY, '1');
	} catch {
		/* non-fatal: the in-session connection still gates correctly */
	}
}

/** Clear the "seen it" flag so the explainer shows again. Used for testing/QA. */
export function resetOnchainPrimer() {
	try {
		localStorage.removeItem(DONE_KEY);
	} catch {
		/* ignore */
	}
}

const STYLE_ID = 'tws-onchain-primer-styles';

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.tws-primer { max-width: 30rem; }
.tws-primer__lead {
	margin: 0 0 var(--space-md); color: var(--ink-dim);
	font-size: var(--text-md); line-height: var(--leading-normal);
}
.tws-primer__lead b { color: var(--ink); font-weight: var(--weight-semibold); }
.tws-primer__cards { display: grid; gap: var(--space-sm); margin: 0 0 var(--space-md); }
.tws-primer__card {
	display: grid; grid-template-columns: 2rem 1fr; gap: var(--space-sm);
	align-items: start; padding: var(--space-sm) var(--space-md);
	background: var(--surface-1); border: 1px solid var(--stroke);
	border-radius: var(--radius-md);
}
.tws-primer__ico { font-size: 1.1rem; line-height: 1.35; text-align: center; }
.tws-primer__ct { min-width: 0; }
.tws-primer__ct h4 {
	margin: 0 0 2px; font-size: var(--text-md); font-weight: var(--weight-semibold);
	color: var(--ink); letter-spacing: .005em;
}
.tws-primer__ct p {
	margin: 0; font-size: var(--text-sm); line-height: var(--leading-normal);
	color: var(--ink-dim);
}
.tws-primer__reassure {
	display: flex; gap: var(--space-xs); align-items: center;
	margin: 0 0 var(--space-xs); padding: var(--space-sm) var(--space-md);
	background: rgba(74, 222, 128, .08); border: 1px solid rgba(74, 222, 128, .22);
	border-radius: var(--radius-md); color: var(--ink);
	font-size: var(--text-sm); line-height: var(--leading-normal);
}
.tws-primer__reassure .tws-primer__ico { color: var(--success); }
.tws-primer__wallets { display: grid; gap: var(--space-xs); margin: var(--space-sm) 0 0; }
.tws-primer__wallet {
	display: flex; align-items: center; justify-content: space-between;
	gap: var(--space-sm); padding: var(--space-sm) var(--space-md);
	background: var(--surface-1); border: 1px solid var(--stroke);
	border-radius: var(--radius-md); color: var(--ink);
	font-size: var(--text-md); font-weight: var(--weight-medium);
	text-decoration: none; transition: background .15s ease, border-color .15s ease;
}
.tws-primer__wallet:hover { background: var(--surface-2); border-color: var(--stroke-strong); }
.tws-primer__wallet:focus-visible { outline: 2px solid var(--accent-soft); outline-offset: 2px; }
.tws-primer__wallet small { color: var(--ink-dim); font-weight: var(--weight-regular); font-size: var(--text-xs); }
.tws-primer__steps {
	display: flex; gap: var(--space-2xs); align-items: center;
	margin: 0 0 var(--space-sm); font-size: var(--text-2xs);
	color: var(--ink-dim); text-transform: uppercase; letter-spacing: .08em;
}
.tws-primer__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--stroke-strong); }
.tws-primer__dot--on { background: var(--accent); }
.tws-primer__status {
	margin: var(--space-sm) 0 0; min-height: 1.1rem; font-size: var(--text-sm);
	line-height: var(--leading-normal); color: var(--ink-dim);
}
.tws-primer__status--err { color: var(--danger); }
.tws-primer__status--ok { color: var(--success); }
.tws-primer__back {
	background: none; border: none; padding: 0; margin: 0;
	color: var(--ink-dim); font: inherit; font-size: var(--text-sm);
	cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.tws-primer__back:hover { color: var(--ink); }
.tws-primer__actions-row { display: flex; gap: var(--space-sm); flex-wrap: wrap; }
`;
	(document.head || document.documentElement).appendChild(style);
}

function stepDots(active) {
	const dots = [1, 2, 3]
		.map((n) => `<span class="tws-primer__dot${n <= active ? ' tws-primer__dot--on' : ''}"></span>`)
		.join('');
	return `<div class="tws-primer__steps" aria-hidden="true"><span>Step ${active} of 3</span>${dots}</div>`;
}

const CARDS = [
	{
		ico: '💼',
		h: 'A wallet is your account',
		p: 'A free app that holds your money and signs you in — no password, no email. You stay in control; nobody else can move your funds.',
	},
	{
		ico: '💵',
		h: 'USDC is digital dollars',
		p: 'Payments use USDC, a coin pegged to exactly $1. Five USDC is five dollars — no prices to watch.',
	},
	{
		ico: '⚡',
		h: 'Fees are a rounding error',
		p: 'three.ws runs on Solana, where a transaction costs a fraction of a cent — not the steep fees crypto is infamous for.',
	},
];

function explainerBody(action) {
	const lead = ACTIONS[action] || ACTIONS.default;
	const cards = CARDS.map(
		(c) => `
		<div class="tws-primer__card">
			<div class="tws-primer__ico" aria-hidden="true">${c.ico}</div>
			<div class="tws-primer__ct"><h4>${escHtml(c.h)}</h4><p>${escHtml(c.p)}</p></div>
		</div>`,
	).join('');
	return `
		<div class="tws-primer">
			${stepDots(1)}
			<p class="tws-primer__lead"><b>${escHtml(lead)}</b> Here's everything you need to know — in plain English.</p>
			<div class="tws-primer__cards">${cards}</div>
			<div class="tws-primer__reassure">
				<span class="tws-primer__ico" aria-hidden="true">✓</span>
				<span>Browsing, building and previewing stay free. You only ever pay when you choose to transact — and you'll always see the amount first.</span>
			</div>
		</div>`;
}

function connectBody({ noWallet = false } = {}) {
	const wallets = WALLETS.map(
		(w) => `
		<a class="tws-primer__wallet" href="${escHtml(w.href)}" target="_blank" rel="noopener noreferrer">
			<span>Get ${escHtml(w.name)}</span><small>${escHtml(w.note)} ↗</small>
		</a>`,
	).join('');
	return `
		<div class="tws-primer">
			${stepDots(2)}
			<p class="tws-primer__lead">We'll use your wallet to sign you in securely. One signature — no password to remember, nothing to pay.</p>
			${
				noWallet
					? `<p class="tws-primer__lead">You don't have a wallet yet. Install one of these free extensions, then come back and connect:</p>
				<div class="tws-primer__wallets">${wallets}</div>`
					: `<details class="tws-primer__lead"><summary style="cursor:pointer">Don't have a wallet?</summary>
				<div class="tws-primer__wallets" style="margin-top:var(--space-sm)">${wallets}</div></details>`
			}
			<div class="tws-primer__status" id="tws-primer-status" role="status" aria-live="polite"></div>
		</div>`;
}

function readyBody() {
	return `
		<div class="tws-primer">
			${stepDots(3)}
			<div class="tws-primer__reassure" style="background:rgba(74,222,128,.08)">
				<span class="tws-primer__ico" aria-hidden="true">✓</span>
				<span>Your wallet is connected. You're ready to go on-chain.</span>
			</div>
			<p class="tws-primer__lead">Want a head start? Add some USDC now — or skip it and add funds the moment you transact. Either works.</p>
		</div>`;
}

/**
 * Run the explainer + setup wizard, gating a crypto action.
 *
 * @param {object} [opts]
 * @param {'launch-token'|'monetize'|'tip'|'deploy'|'withdraw'} [opts.action]
 *   Drives the one-line framing of why the primer appeared.
 * @param {boolean} [opts.force]  Show even if the user is already crypto-ready.
 * @returns {Promise<boolean>}  true → proceed; false → user backed out.
 */
export function ensureOnchainPrimer({ action = 'default', force = false } = {}) {
	if (!force && isOnchainReady()) return Promise.resolve(true);
	if (typeof document === 'undefined') return Promise.resolve(true);

	ensureStyles();

	return new Promise((resolve) => {
		// Tracks whether the user reached a wallet-ready state. The modal can be
		// dismissed at any time; we resolve with this so closing *after* connecting
		// still lets the action proceed, while bailing *before* aborts it.
		let ready = false;
		let settled = false;

		const modal = new Modal({
			title: 'Before you go on-chain',
			body: explainerBody(action),
			onClose: () => {
				if (settled) return;
				settled = true;
				resolve(ready);
			},
		});

		const finish = (value) => {
			ready = value;
			settled = true;
			resolve(value);
			modal.destroy();
		};

		// ── Step renderers ────────────────────────────────────────────────────
		function renderExplainer() {
			modal.titleEl.textContent = 'Before you go on-chain';
			modal.bodyEl.innerHTML = explainerBody(action);
			modal.actionsEl.hidden = false;
			modal.actionsEl.innerHTML = `
				<button class="btn btn--ghost" data-act="cancel" type="button">Not now</button>
				<button class="btn btn--primary" data-act="setup" type="button">Set up my wallet <span class="arrow">→</span></button>`;
		}

		function renderConnect({ noWallet = false } = {}) {
			modal.titleEl.textContent = 'Connect your wallet';
			modal.bodyEl.innerHTML = connectBody({ noWallet });
			modal.actionsEl.hidden = false;
			modal.actionsEl.innerHTML = `
				<button class="btn btn--ghost" data-act="back" type="button">← Back</button>
				<button class="btn btn--ghost" data-act="email" type="button">Use email instead</button>
				<button class="btn btn--primary" data-act="connect" type="button">Connect wallet</button>`;
		}

		function renderReady() {
			modal.titleEl.textContent = "You're all set";
			modal.bodyEl.innerHTML = readyBody();
			modal.actionsEl.hidden = false;
			modal.actionsEl.innerHTML = `
				<button class="btn btn--secondary" data-act="fund" type="button">Add USDC</button>
				<button class="btn btn--primary" data-act="continue" type="button">Continue <span class="arrow">→</span></button>`;
		}

		// ── Connect handler — reuses the canonical site sign-in ───────────────
		async function doConnect(btn) {
			const statusEl = modal.bodyEl.querySelector('#tws-primer-status');
			// No injected wallet at all → route to the install-a-wallet view.
			if (!window.ethereum && !window.solana) {
				renderConnect({ noWallet: true });
				return;
			}
			btn.setAttribute('aria-busy', 'true');
			btn.disabled = true;
			if (statusEl) {
				statusEl.className = 'tws-primer__status';
				statusEl.textContent = 'Waiting for your wallet…';
			}
			try {
				await signInWithWallet();
				markDone();
				ready = true; // connected — dismissing now still proceeds
				renderReady();
			} catch (err) {
				btn.removeAttribute('aria-busy');
				btn.disabled = false;
				const msg = String(err?.message || err || '');
				const rejected = /reject|denied|cancell?ed|4001/i.test(msg);
				if (statusEl) {
					statusEl.className = 'tws-primer__status tws-primer__status--err';
					statusEl.textContent = rejected
						? 'Sign-in cancelled. Click Connect when you’re ready.'
						: `Couldn’t connect: ${msg || 'please try again.'}`;
				}
			}
		}

		// ── Fund handler — reuses the Add-funds overlay ───────────────────────
		async function doFund(btn) {
			const address = (() => {
				try {
					return getWalletState().address || '';
				} catch {
					return '';
				}
			})();
			btn.disabled = true;
			// Close our modal so the funding overlay owns the screen, then resolve
			// regardless of the funding outcome — they're already wallet-ready.
			modal.destroy();
			await showAddFunds({ walletAddress: address }).catch(() => null);
			if (!settled) {
				ready = true;
				settled = true;
				resolve(true);
			}
		}

		// ── One delegated click handler for every step ────────────────────────
		modal.actionsEl.addEventListener('click', (e) => {
			const btn = e.target.closest('button[data-act]');
			if (!btn) return;
			switch (btn.dataset.act) {
				case 'cancel':
					finish(false);
					break;
				case 'setup':
					renderConnect();
					break;
				case 'back':
					renderExplainer();
					break;
				case 'connect':
					doConnect(btn);
					break;
				case 'email':
					try {
						sessionStorage.setItem('login_redirect', location.href);
					} catch {
						/* ignore */
					}
					location.href = '/login?from=onchain-primer';
					break;
				case 'fund':
					doFund(btn);
					break;
				case 'continue':
					finish(true);
					break;
				default:
					break;
			}
		});

		renderExplainer();
		modal.open();
	});
}

if (typeof window !== 'undefined') {
	window.twsOnchainPrimer = {
		ensure: ensureOnchainPrimer,
		isReady: isOnchainReady,
		reset: resetOnchainPrimer,
	};
}
