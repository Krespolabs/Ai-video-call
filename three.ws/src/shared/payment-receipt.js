/**
 * payment-receipt.js — human-readable receipt line for confirmed payments.
 *
 * Replaces raw tx hash + explorer links with plain text that reads like any
 * payment app: "✓ Paid $0.01 to Luna's creator · 2s · details ↗"
 *
 * All user-supplied strings are HTML-escaped. Explorer URL is validated to
 * be a known safe domain before being injected as an href.
 */

const SAFE_EXPLORER_ORIGINS = new Set([
	'https://solscan.io',
	'https://explorer.solana.com',
	'https://solana.fm',
	'https://xray.helius.xyz',
	'https://etherscan.io',
	'https://basescan.org',
	'https://arbiscan.io',
]);

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function safeExplorerHref(url) {
	try {
		const u = new URL(url);
		const origin = u.origin.replace(/\/$/, '');
		return SAFE_EXPLORER_ORIGINS.has(origin) ? url : null;
	} catch {
		return null;
	}
}

/**
 * Format USDC atomic units (1e6) or a decimal value to a USD-style string.
 *
 * When `isAtomic` is passed it is honoured exactly. When it is omitted the
 * magnitude heuristic applies: any payable micro-USDC amount is >= 1000 atomic,
 * so values >= 1000 are treated as atomic and smaller values as already-decimal.
 * Passing `false` explicitly forces decimal interpretation so a real dollar
 * amount like 1234.56 is not mistaken for atomic and shrunk to "$0.0012".
 *
 * @param {number} amount
 * @param {boolean} [isAtomic] force (true) or forbid (false) atomic interpretation; omit to auto-detect
 * @returns {string}  e.g. "$0.01"
 */
export function formatUsdcAmount(amount, isAtomic) {
	const n = Number(amount) || 0;
	const atomic = isAtomic === undefined ? n >= 1000 : isAtomic;
	const decimal = atomic ? n / 1e6 : n;
	if (decimal < 0.01) return `$${decimal.toFixed(4)}`;
	if (decimal < 1) return `$${decimal.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.00')}`;
	if (decimal < 100) return `$${decimal.toFixed(2)}`;
	return `$${Math.round(decimal).toLocaleString()}`;
}

/**
 * Format elapsed milliseconds to a compact string ("2s", "1m", "just now").
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
	const s = Math.round((ms || 0) / 1000);
	if (s < 2) return 'just now';
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.round(m / 60)}h`;
}

/**
 * Build a human-readable receipt HTML string.
 *
 * @param {object} params
 * @param {number}  [params.usdAmount]        already-decimal USD amount (e.g. 0.01)
 * @param {number}  [params.usdcAtomic]       atomic USDC (1e6 scale) — used if usdAmount not given
 * @param {string}  [params.recipientLabel]   e.g. "Luna's creator" or a short address
 * @param {number}  [params.elapsedMs]        ms since tx sent (used for "2s" timing)
 * @param {string}  [params.explorerUrl]      full Solscan/explorer URL
 * @param {string}  [params.signature]        raw tx signature (shown truncated in details fallback)
 * @returns {string}  Safe HTML for innerHTML insertion
 */
export function buildReceiptHTML({
	usdAmount,
	usdcAtomic,
	recipientLabel,
	elapsedMs,
	explorerUrl,
	signature,
} = {}) {
	const amountStr =
		usdAmount != null
			? formatUsdcAmount(usdAmount, false)
			: usdcAtomic != null
			? formatUsdcAmount(usdcAtomic, true)
			: null;

	const toStr = recipientLabel ? ` to ${esc(recipientLabel)}` : '';
	const timeStr = elapsedMs != null ? ` · ${esc(formatElapsed(elapsedMs))}` : '';
	const amountPart = amountStr ? `${esc(amountStr)}` : 'payment';

	const safeHref = explorerUrl ? safeExplorerHref(explorerUrl) : null;
	let detailsPart = '';
	if (safeHref) {
		detailsPart = ` · <a class="receipt-detail" href="${esc(safeHref)}" target="_blank" rel="noopener noreferrer">details ↗</a>`;
	} else if (signature) {
		const short = `${signature.slice(0, 6)}…${signature.slice(-4)}`;
		detailsPart = ` · <span class="receipt-sig">${esc(short)}</span>`;
	}

	return `<span class="receipt-ok">✓ Paid ${amountPart}${toStr}${timeStr}</span>${detailsPart}`;
}

/**
 * Build a compact single-line plain-text receipt (for status bars / toasts).
 */
export function buildReceiptText({ usdAmount, usdcAtomic, recipientLabel, elapsedMs } = {}) {
	const amountStr =
		usdAmount != null
			? formatUsdcAmount(usdAmount, false)
			: usdcAtomic != null
			? formatUsdcAmount(usdcAtomic, true)
			: 'payment';
	const toStr = recipientLabel ? ` to ${recipientLabel}` : '';
	const timeStr = elapsedMs != null ? ` · ${formatElapsed(elapsedMs)}` : '';
	return `✓ Paid ${amountStr}${toStr}${timeStr}`;
}
