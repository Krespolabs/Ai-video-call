// Agora — shared formatting helpers for the trust surface (job detail, verify,
// passport, handshake). Pure functions, no DOM, no network — safe to unit-test.
// Every value the panels render passes through here so $THREE amounts, hashes,
// addresses, timestamps and explorer links read identically everywhere.

// $THREE is an SPL token with 6 decimals (see api/_lib/autopilot.js THREE_DECIMALS).
export const THREE_DECIMALS = 6;

// Format an atomic $THREE amount (string|number|bigint of base units) as a
// human reward, e.g. 25_000_000_000 → "25,000". Falls back to "0" on garbage.
export function formatThree(atomic) {
	let n;
	try {
		n = typeof atomic === 'bigint' ? atomic : BigInt(String(atomic ?? '0').split('.')[0] || '0');
	} catch {
		return '0';
	}
	const base = 10n ** BigInt(THREE_DECIMALS);
	const whole = n / base;
	const frac = n % base;
	const wholeStr = whole.toLocaleString('en-US');
	if (frac === 0n) return wholeStr;
	// Show up to 2 significant fractional digits, trimmed.
	const fracStr = (frac * 100n / base).toString().padStart(2, '0').replace(/0+$/, '');
	return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
}

// Lamports (1e9 per SOL) → a short SOL string. Used for slashable stake.
export function formatSol(lamports) {
	let n;
	try {
		n = typeof lamports === 'bigint' ? lamports : BigInt(String(lamports ?? '0').split('.')[0] || '0');
	} catch {
		return '0';
	}
	const sol = Number(n) / 1e9;
	if (sol === 0) return '0';
	if (sol < 0.001) return sol.toExponential(2);
	return sol.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// Truncate a base58 address / 64-char hash for display: keep head+tail.
export function shortId(value, head = 4, tail = 4) {
	const s = String(value ?? '');
	if (s.length <= head + tail + 1) return s;
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Normalize a hash to lowercase hex with no 0x prefix — the canonical form the
// on-chain proofHash and a browser-computed digest are compared in.
export function normalizeHex(value) {
	let s = String(value ?? '').trim().toLowerCase();
	if (s.startsWith('0x')) s = s.slice(2);
	return s;
}

// Solana Explorer link for a tx signature. Cluster 'devnet' appends the query;
// mainnet uses the default (mainnet-beta) network.
export function explorerTxUrl(signature, cluster = 'devnet') {
	if (!signature) return null;
	const suffix = cluster === 'mainnet' ? '' : '?cluster=devnet';
	return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

// Solana Explorer link for an account/address (agent PDA, asset, mint).
export function explorerAddressUrl(address, cluster = 'devnet') {
	if (!address) return null;
	const suffix = cluster === 'mainnet' ? '' : '?cluster=devnet';
	return `https://explorer.solana.com/address/${address}${suffix}`;
}

// Etherscan link for an EVM address (the ERC-8004 side of the handshake).
export function etherscanAddressUrl(address) {
	if (!address) return null;
	return `https://etherscan.io/address/${address}`;
}

// Relative time, e.g. "3m ago", "2h ago", "5d ago". Accepts ISO strings or
// unix seconds (on-chain timestamps come back as seconds). null → "—".
export function timeAgo(input) {
	if (input == null) return '—';
	let ms;
	if (typeof input === 'number') {
		// On-chain timestamps are unix seconds; JS Date wants ms.
		ms = input < 1e12 ? input * 1000 : input;
	} else {
		ms = Date.parse(input);
	}
	if (!Number.isFinite(ms)) return '—';
	const diff = Date.now() - ms;
	if (diff < 0) return 'just now';
	const sec = Math.floor(diff / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mon = Math.floor(day / 30);
	if (mon < 12) return `${mon}mo ago`;
	return `${Math.floor(mon / 12)}y ago`;
}

// Absolute, human timestamp for tooltips/title attributes.
export function absoluteTime(input) {
	if (input == null) return '';
	let ms;
	if (typeof input === 'number') ms = input < 1e12 ? input * 1000 : input;
	else ms = Date.parse(input);
	if (!Number.isFinite(ms)) return '';
	return new Date(ms).toLocaleString('en-US', {
		year: 'numeric', month: 'short', day: 'numeric',
		hour: '2-digit', minute: '2-digit',
	});
}

// Bytes → human size, e.g. 1536 → "1.5 KB". For the verify size readout.
export function formatBytes(bytes) {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n < 0) return '—';
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// Title-case a profession key, e.g. "sculptor" → "Sculptor".
export function professionLabel(key) {
	const s = String(key ?? '').trim();
	if (!s) return '';
	return s[0].toUpperCase() + s.slice(1);
}
