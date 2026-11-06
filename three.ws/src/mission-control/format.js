/**
 * Mission Control — display formatting. Reuses the wallet-hub primitives where
 * they already exist (escape, addresses, SOL, explorer links, relative time) and
 * adds the compact market-data formatters the terminal needs.
 */

export {
	escapeHtml,
	shortAddress,
	formatSol,
	formatUsd,
	timeAgo,
	explorerTxUrl,
	explorerAddressUrl,
	copyToClipboard,
} from '../agent-wallet-hub/util.js';

/** Compact USD market cap: $1.2K, $34.5K, $1.2M, $3.4B. Null → "—". */
export function formatCompactUsd(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const abs = Math.abs(v);
	const sign = v < 0 ? '-' : '';
	if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
	if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
	if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
	return `${sign}$${abs.toFixed(abs < 1 ? 2 : 0)}`;
}

/** Compact plain number: 1.2K, 34M. */
export function formatCompact(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const abs = Math.abs(v);
	if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
	if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
	return String(Math.round(v));
}

/** Short "age" from a unix-seconds creation time: 4s, 12m, 3h, 2d. */
export function ageFrom(unixSeconds) {
	if (!unixSeconds) return '';
	const sec = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
	return `${Math.floor(sec / 86400)}d`;
}

/** Signed percent with one decimal: +12.4%, -3.1%. Null → "—". */
export function formatPct(pct) {
	if (pct == null || !Number.isFinite(Number(pct))) return '—';
	const v = Number(pct);
	return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Signed SOL for PnL: +0.42, -0.13. Null → "—". */
export function formatSolDelta(sol) {
	if (sol == null || !Number.isFinite(Number(sol))) return '—';
	const v = Number(sol);
	return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
}

/** 'pos' | 'neg' | 'flat' for a signed value — drives PnL colour classes. */
export function signClass(v) {
	if (v == null || !Number.isFinite(Number(v))) return 'flat';
	const n = Number(v);
	return n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
}

/** Verdict → { label, tone } for firewall/intel chips. */
export function verdictChip(verdict) {
	switch (verdict) {
		case 'allow':
			return { label: 'CLEAR', tone: 'allow' };
		case 'warn':
			return { label: 'CAUTION', tone: 'warn' };
		case 'block':
			return { label: 'BLOCK', tone: 'block' };
		default:
			return { label: '—', tone: 'unknown' };
	}
}
