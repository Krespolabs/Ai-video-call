// Per-tool pricing for paid MCP tools, settled via pump-agent-payments.
//
// Today: a static map keyed by tool name → { amount_usdc, currency_mint?, recipient_mint? }.
//   - `amount_usdc` is the price per call (for one-shots) or per window (for subs).
//   - `recipient_mint` defaults to env.PUMP_DEFAULT_AGENT_MINT — the platform agent.
//   - Tools omitted from this map are free.
//
// Subscription bypass: if a payer has a confirmed `pump_agent_payments` row
// for the resolved mint whose end_time is in the future and tool_name matches
// (or is null = unrestricted access), the call is permitted without a fresh
// payment.
//
// We expose this map via the existing tools/list response so MCP clients see
// the price next to each tool.

import { sql } from './db.js';

export const TOOL_PRICING = Object.freeze({
	// Heavy compute or external calls — priced.
	optimize_model: { amount_usdc: 0.05, description: 'Per call' },
	segment_model: { amount_usdc: 0.04, description: 'Per call — split a mesh into named parts' },
	inspect_model: { amount_usdc: 0.01, description: 'Per call' },
	validate_model: { amount_usdc: 0.01, description: 'Per call' },
	render_avatar: { amount_usdc: 0.005, description: 'Per call' },
	apply_animation: {
		amount_usdc: 0.02,
		description: 'Per call — retarget + bake an animated GLB',
	},
	// 3D Studio generation tools — GPU-bound, priced per call. A full surface
	// retexture regenerates every viewpoint (minutes of GPU); the magic-brush
	// region edit only inpaints one masked patch, so it is priced well below it.
	retexture_model: { amount_usdc: 0.1, description: 'Per full retexture' },
	retexture_region: { amount_usdc: 0.03, description: 'Per region edit (magic brush)' },
	// Public gallery search — a real DB query that ranks the whole public avatar
	// corpus and resolves a signed thumbnail per hit. Priced as the cheapest
	// metered call so anonymous x402 agents (and the autonomous warmup loop) pay
	// per search; authenticated OAuth callers bypass payment entirely (they hold a
	// bearer token, so authenticateRequest never issues the x402 challenge).
	search_public_avatars: { amount_usdc: 0.001, description: 'Per call — public avatar gallery search' },
	// On-chain agent reputation summary — a cheap indexed read, priced so the
	// autonomous reputation-refresh pipeline exercises it as a real x402 call and
	// external agents pay the going rate to vet a counterparty.
	solana_agent_reputation: { amount_usdc: 0.001, description: 'Per call — on-chain agent reputation summary' },
	// Tokenize a 3D asset — a real on-chain Solana mint: durable media promotion
	// (R2 + IPFS), a headless thumbnail render, metadata upload, and a Metaplex
	// Core mint whose rent the platform authority pays. Priced to cover rent +
	// compute. The read-back (get_3d_asset_onchain) is a free public read.
	mint_3d_asset: { amount_usdc: 0.25, description: 'Per mint — on-chain Solana 3D NFT (media + rent)' },
	// Discovery / lookups (incl. list_animations, get_3d_asset_onchain) — free
});

export function priceFor(toolName) {
	return TOOL_PRICING[toolName] || null;
}

export function isFreeTool(toolName) {
	return !TOOL_PRICING[toolName];
}

// USDC (and our other supported stables) are 6-decimal. The x402 wire `amount`
// is an atomic-unit string; convert a human `amount_usdc` to that. Rounds to the
// nearest atomic unit so fractional-cent prices (e.g. 0.005) map exactly.
const USDC_DECIMALS = 6;
export function usdcToAtomicString(amountUsdc) {
	const atomic = Math.round(Number(amountUsdc) * 10 ** USDC_DECIMALS);
	return String(atomic);
}

/**
 * The x402 `amount` (atomic-unit string) to charge for a given MCP tools/call.
 * Derived from the advertised per-tool price so the 402 challenge and the
 * settled charge agree. Returns null for free tools (no charge).
 *
 * @param {string} toolName
 * @returns {string|null}
 */
export function x402AmountForTool(toolName) {
	const price = priceFor(toolName);
	if (!price || !(price.amount_usdc > 0)) return null;
	return usdcToAtomicString(price.amount_usdc);
}

/**
 * Returns the active subscription row for (mint, payerWallet, toolName) if one
 * exists, has not expired, AND was paid at least `minAmountAtomics`.
 * `toolName=null` matches any unrestricted subscription. Returns null otherwise.
 *
 * The amount floor is essential: the payer chooses both `amount_usdc` and
 * `duration_seconds` when prepping an invoice, so without it a caller could pay
 * a fraction of a cent and unlock a tool priced per-call for as long as they
 * like. Callers MUST pass the tool's advertised price (as an atomic-unit string)
 * so a confirmed-but-underpaid invoice never satisfies the gate. Defaults to '0'
 * only for callers that have no price (free tools), which never reach this path.
 */
export async function findActiveSubscription({
	mint,
	network = 'mainnet',
	payerWallet,
	toolName,
	minAmountAtomics = '0',
}) {
	if (!mint || !payerWallet) return null;
	const floor = String(minAmountAtomics ?? '0');
	const [row] = await sql`
		select p.id, p.invoice_id, p.amount_atomics, p.end_time, p.tool_name
		from pump_agent_payments p
		join pump_agent_mints m on m.id = p.mint_id
		where m.mint = ${mint}
		  and m.network = ${network}
		  and p.payer_wallet = ${payerWallet}
		  and p.status = 'confirmed'
		  and p.end_time > now()
		  and p.amount_atomics >= ${floor}::numeric
		  and (p.tool_name is null or p.tool_name = ${toolName || null})
		order by p.end_time desc
		limit 1
	`;
	return row || null;
}

/**
 * Resolve the destination pump.fun mint for a tool call. Defaults to the
 * platform-wide agent (env.PUMP_DEFAULT_AGENT_MINT) when one is configured;
 * a future enhancement is per-resource (per agent_id) routing.
 */
export function resolveBillingMint() {
	return process.env.PUMP_DEFAULT_AGENT_MINT || null;
}
