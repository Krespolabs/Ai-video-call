/**
 * Solana Pay transfer-request URIs — the one builder every surface shares.
 *
 * A `solana:<recipient>[?amount=…][&label=…]` deep link opens Phantom /
 * Solflare / Backpack pre-filled with the agent's public receive address. It is
 * what the wallet-hub Deposit tab renders as a QR, what IRL/AR encodes for
 * tap-to-tip in the real world, and what the portable embed wallet hands to a
 * phone. Keeping it here means the address/label/amount encoding is identical
 * everywhere and there is no per-surface copy to drift.
 *
 * Public data only: the recipient is the agent's PUBLIC solana_address, so this
 * never touches a secret. Per the Solana Pay spec `amount` is a decimal in SOL.
 */
export function buildSolanaPayUri(address, { amount, label } = {}) {
	if (!address || typeof address !== 'string') return null;
	const params = new URLSearchParams();
	const amt = Number(amount);
	if (Number.isFinite(amt) && amt > 0) {
		// Trim to a sane lamport precision (9 dp) and drop trailing zeros.
		params.set('amount', String(amt).slice(0, 24));
	}
	if (label) params.set('label', label);
	const qs = params.toString();
	return `solana:${address}${qs ? `?${qs}` : ''}`;
}
