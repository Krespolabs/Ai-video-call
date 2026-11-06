// Pure shaping + cursor helpers for the Galaxy Money-Cam flow feed
// (GET /api/galaxy/flows). Kept dependency-free so they are unit-testable without
// a database or RPC — the endpoint (api/galaxy/flows.js) owns all I/O and calls
// into these to turn a DB row into the public flow event the 3D map renders.
//
// A "flow" is one real, on-chain, explorer-verifiable money movement that touches
// at least one public platform agent. Every flow has a real signature (or a real
// launch mint). There are NO synthetic flows — if the platform is quiet, the feed
// is honestly empty and the galaxy stays calm.

// Custody categories that are safe to surface publicly. Everything else
// (withdraw, vanity_swap, limit_change, key_recover) is owner-private and is
// excluded by the endpoint's WHERE clause — never add those here.
export const PUBLIC_SPEND_CATEGORIES = ['trade', 'snipe', 'x402'];

// type= query param → the set of `kind`s it admits (mirrors /api/pulse).
export const TYPE_KINDS = {
	all: ['tip', 'trade', 'snipe', 'payment', 'launch'],
	tips: ['tip'],
	trades: ['trade', 'snipe'],
	payments: ['payment'],
	launches: ['launch'],
};

// Keyset cursor = base64url("<epoch_ms>|<row_id>"). row_id is the unified id of
// the boundary row; comparing (ts, row_id) gives a stable total order across the
// UNION so pagination/delta-polling never skips or duplicates a flow. Identical
// scheme to /api/pulse so the two feeds stay interchangeable.
export function encodeCursor(tsIso, rowId) {
	const ms = new Date(tsIso).getTime();
	return Buffer.from(`${ms}|${rowId}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
	if (!raw || typeof raw !== 'string') return null;
	try {
		const [ms, rowId] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
		const n = Number(ms);
		if (!Number.isFinite(n) || !rowId) return null;
		return { ts: new Date(n).toISOString(), rowId };
	} catch {
		return null;
	}
}

// Solscan URLs — inlined (not imported from avatar-wallet.js) so this module
// stays free of Solana deps and trivially testable. Matches avatar-wallet.js.
export function txExplorerUrl(signature, network) {
	if (!signature) return null;
	const cluster = network === 'devnet' ? '?cluster=devnet' : '';
	return `https://solscan.io/tx/${signature}${cluster}`;
}
export function accountExplorerUrl(address, network) {
	if (!address) return null;
	const cluster = network === 'devnet' ? '?cluster=devnet' : '';
	return `https://solscan.io/account/${address}${cluster}`;
}

// Shape one DB row into the public flow event the Money-Cam renders. Pure.
//
// Direction is truthful by construction:
//   · tip   → 'in'     money ARRIVES at the actor (sender = meta.from)
//   · spend → 'out'    money LEAVES the actor    (recipient = destination)
//   · launch→ 'launch' the actor minted a coin   (no counterparty)
// from/to are then derived from direction so the client can animate a pulse in
// the real direction value moved. The counterparty agent is resolved server-side
// only when its wallet maps to another PUBLIC platform agent — otherwise it stays
// a bare wallet (or null) and the client flares the single node instead of
// fabricating a second star.
export function shapeFlow(r) {
	const network = r.network;
	const amountLamports = r.amount_lamports != null ? String(r.amount_lamports) : null;
	const amountRaw = r.amount_raw != null ? String(r.amount_raw) : null;
	const sol = amountLamports != null ? Number(amountLamports) / 1e9 : null;
	const usd = r.usd != null ? Number(r.usd) : null;
	const sig = r.signature || null;

	const actor = {
		id: r.actor_id,
		name: r.actor_name || 'Agent',
		wallet: r.actor_addr || null,
		vanity_prefix: r.actor_vp || null,
		vanity_suffix: r.actor_vs || null,
	};
	const counterparty = r.counterparty_addr
		? { id: r.counterparty_id || null, name: r.counterparty_name || null, wallet: r.counterparty_addr }
		: null;

	// from → to in real money-flow direction.
	let from = null;
	let to = null;
	if (r.direction === 'in') {
		from = counterparty;
		to = actor;
	} else if (r.direction === 'out') {
		from = actor;
		to = counterparty;
	} else {
		from = actor; // launch: the actor acts on itself
		to = null;
	}

	return {
		id: r.row_id,
		kind: r.kind, // tip | trade | snipe | payment | launch
		direction: r.direction, // in | out | launch
		ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
		network,
		asset: r.asset || null,
		amount_lamports: amountLamports,
		amount_raw: amountRaw,
		sol,
		usd,
		signature: sig,
		explorer: txExplorerUrl(sig, network),
		actor,
		counterparty,
		from,
		to,
		// launch-only
		mint: r.mint || null,
		symbol: r.symbol || null,
		coin_name: r.coin_name || null,
		mint_explorer: accountExplorerUrl(r.mint, network),
	};
}

// A flow is an agent↔agent EDGE only when both endpoints are real platform agents
// (the counterparty wallet resolved to another public agent and it is not the
// actor itself). Otherwise it is a single-node event (a flare). Pure predicate,
// used by both the endpoint summary and the client.
export function isAgentEdge(flow) {
	return Boolean(
		flow &&
			flow.counterparty &&
			flow.counterparty.id &&
			flow.actor &&
			flow.counterparty.id !== flow.actor.id,
	);
}
