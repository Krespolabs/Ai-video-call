/**
 * Shared crypto-error message map for three.ws.
 *
 * Every key maps to { title, body, actions } — plain language, no env-var names,
 * no raw protocol codes surfaced to users.
 *
 * actions: Array<{ label, href?, onClick? }>
 *   - href  → renders as an anchor (navigation)
 *   - onClick → renders as a button
 *
 * Consumers: wire these strings into whatever shell they use (error banner,
 * modal status, feed item, etc.). Technical detail goes to console, not UI.
 */

import { log } from './log.js';

// Internal error codes that must never appear in UI strings
const REDACTED_PATTERNS = [
	/AVATAR_WALLET_SECRET/gi,
	/AGENT_[A-Z_]+/gi,
	/wallet_unconfigured/gi,
	/no_recipient/gi,
	/NO_WALLET/gi,
];

/**
 * Scrub any internal config names from a message before surfacing it.
 * @param {string} msg
 * @returns {string}
 */
export function sanitizeErrorMessage(msg) {
	if (!msg || typeof msg !== 'string') return '';
	let out = msg;
	for (const pattern of REDACTED_PATTERNS) {
		out = out.replace(pattern, '[configuration]');
	}
	return out;
}

/**
 * The error message map.
 * Keys: canonical error codes / causes.
 * Values: { title, body, actions }
 *
 * title  — short, human, sentence-case
 * body   — 1-2 sentences explaining what happened + why
 * actions — ordered list of actions; first is primary
 */
export const ERROR_MESSAGES = {
	NO_WALLET: {
		title: 'No wallet connected',
		body: 'Connect a Solana wallet to deploy your agent on-chain. If you don\'t have one yet, Phantom takes about a minute to set up.',
		actions: [
			{ label: 'Connect wallet', onClick: 'connectWallet' },
			{ label: 'Get Phantom', href: 'https://phantom.app/' },
		],
	},

	NO_WALLET_ETHEREUM: {
		title: 'No wallet detected',
		body: 'A browser wallet extension is needed to sign in. Install MetaMask or Coinbase Wallet, then return here.',
		actions: [
			{ label: 'Get MetaMask', href: 'https://metamask.io/' },
			{ label: 'Get Coinbase Wallet', href: 'https://www.coinbase.com/wallet' },
		],
	},

	insufficient_balance: {
		title: 'Not enough funds',
		body: 'Your wallet balance is too low to complete this transaction. A small amount of SOL covers the network fee.',
		actions: [
			{ label: 'Add funds', onClick: 'openFundFlow' },
			{ label: 'Check balance', onClick: 'checkBalance' },
		],
	},

	wallet_unconfigured: {
		title: 'Service temporarily unavailable',
		body: 'Something on our end isn\'t quite ready yet. Please try again in a moment.',
		actions: [
			{ label: 'Try again', onClick: 'retry' },
		],
	},

	no_recipient: {
		title: 'Service temporarily unavailable',
		body: 'Something on our end isn\'t quite ready yet. Please try again in a moment.',
		actions: [
			{ label: 'Try again', onClick: 'retry' },
		],
	},

	user_rejected: {
		title: 'Transaction cancelled',
		body: 'You declined the transaction in your wallet. Nothing was sent.',
		actions: [
			{ label: 'Try again', onClick: 'retry' },
		],
	},

	network_error: {
		title: 'Connection problem',
		body: 'We couldn\'t reach the network. Check your connection and try again.',
		actions: [
			{ label: 'Try again', onClick: 'retry' },
		],
	},

	tx_failed: {
		title: 'Transaction didn\'t go through',
		body: 'The network rejected the transaction. This can happen when fees spike — try again in a moment.',
		actions: [
			{ label: 'Try again', onClick: 'retry' },
		],
	},

	verification_failed: {
		title: 'Verification pending',
		body: 'Your payment may have gone through but we couldn\'t confirm it yet. Check your wallet history and contact support if funds were deducted.',
		actions: [
			{ label: 'Contact support', href: 'mailto:support@three.ws' },
		],
	},

	phantom_not_detected: {
		title: 'Phantom not found',
		body: 'The Phantom wallet extension isn\'t installed. Install it in a minute and come back.',
		actions: [
			{ label: 'Install Phantom', href: 'https://phantom.app/' },
		],
	},

	sign_in_failed: {
		title: 'Sign-in failed',
		body: 'We couldn\'t complete the sign-in. Try connecting your wallet again.',
		actions: [
			{ label: 'Try again', onClick: 'retry' },
		],
	},

	session_expired: {
		title: 'Session expired',
		body: 'Your session has ended. Sign in again to continue.',
		actions: [
			{ label: 'Sign in', onClick: 'connectWallet' },
		],
	},

	forbidden: {
		title: 'Not authorised',
		body: 'Your account doesn\'t have access to this yet. Make sure your wallet is linked and try again.',
		actions: [
			{ label: 'Go to deploy console', href: '/deploy' },
		],
	},

	generic: {
		title: 'Something went wrong',
		body: 'An unexpected error occurred. Try again — if it keeps happening, contact support.',
		actions: [
			{ label: 'Try again', onClick: 'retry' },
		],
	},
};

/**
 * Resolve an error to a friendly message entry.
 * Logs the raw technical detail to console.
 *
 * @param {string|Error|{code?:string, error?:string, message?:string, status?:number}} err
 * @param {string} [contextLabel]  — label for console grouping
 * @returns {{ title: string, body: string, actions: Array<{label:string, href?:string, onClick?:string}> }}
 */
export function resolveError(err, contextLabel = 'crypto-error') {
	// Log technical detail privately
	log.error(`[three.ws] ${contextLabel}`, err);

	const code = typeof err === 'string' ? err
		: (err?.code || err?.error || '');
	const msg = typeof err === 'string' ? err
		: (err?.message || '');
	const status = typeof err === 'object' ? err?.status : undefined;

	// User-cancelled signature (various wallets word this differently)
	if (/reject|denied|cancel|user.*declin/i.test(msg)) {
		return ERROR_MESSAGES.user_rejected;
	}

	// Network / fetch failures
	if (/network|fetch|failed to fetch|econnrefused/i.test(msg)) {
		return ERROR_MESSAGES.network_error;
	}

	// Phantom / wallet not installed
	if (/phantom not detected|phantom not found|no.*solana|solana.*not/i.test(msg)) {
		return ERROR_MESSAGES.phantom_not_detected;
	}

	// HTTP 401
	if (status === 401) {
		return ERROR_MESSAGES.session_expired;
	}

	// HTTP 403
	if (status === 403 || code === 'forbidden') {
		return ERROR_MESSAGES.forbidden;
	}

	// Known code map
	if (code && ERROR_MESSAGES[code]) {
		return ERROR_MESSAGES[code];
	}

	return ERROR_MESSAGES.generic;
}

/**
 * Render a friendly error banner into a container element.
 * Replaces its content with title, body, and action buttons/links.
 *
 * @param {HTMLElement} container
 * @param {ReturnType<typeof resolveError>} entry
 * @param {Record<string, () => void>} handlers  — maps onClick strings to real functions
 */
export function renderErrorBanner(container, entry, handlers = {}) {
	container.innerHTML = '';
	container.setAttribute('role', 'alert');
	container.setAttribute('aria-live', 'assertive');

	const titleEl = document.createElement('strong');
	titleEl.className = 'err-title';
	titleEl.textContent = entry.title;

	const bodyEl = document.createElement('p');
	bodyEl.className = 'err-body';
	bodyEl.textContent = entry.body;

	const actionsEl = document.createElement('div');
	actionsEl.className = 'err-actions';

	for (const action of (entry.actions || [])) {
		if (action.href) {
			const a = document.createElement('a');
			a.className = 'err-action err-action-link';
			a.href = action.href;
			if (action.href.startsWith('http')) {
				a.target = '_blank';
				a.rel = 'noopener noreferrer';
			}
			a.textContent = action.label;
			actionsEl.appendChild(a);
		} else if (action.onClick) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'err-action err-action-btn';
			btn.textContent = action.label;
			const handler = handlers[action.onClick];
			if (handler) {
				btn.addEventListener('click', handler);
			} else {
				btn.disabled = true;
			}
			actionsEl.appendChild(btn);
		}
	}

	container.append(titleEl, bodyEl, actionsEl);
}
