// Normalize a stored tip/payout network identifier to the chain key the club
// payout senders and dancer-wallet columns are keyed on.
//
// club_tips.network is written from the x402 requirement, so a SETTLED tip
// carries a CAIP-2 chain id ('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
// 'eip155:8453'), while a BYPASS (free-pass) ticket carries the bare chain key
// ('solana', 'base'). Both forms denote the same chain. The sweep compares
// `network === 'solana'` to choose the recipient column and per-network sender,
// so without this collapse every settled Solana tip falls through to the EVM
// branch and is skipped as "no wallet" even when a Solana address is registered.
//
// Unknown values pass through unchanged so they surface as an explicit
// "unsupported network" downstream rather than being silently mis-routed.
export function chainOf(network) {
	const n = String(network || '').trim().toLowerCase();
	if (n === 'solana' || n.startsWith('solana:')) return 'solana';
	if (n === 'base' || n === 'eip155:8453') return 'base';
	return n;
}
