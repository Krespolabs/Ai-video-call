// agent-sniper — pump.fun trade client + transaction broadcast.
//
// Thin wrapper over the platform's PumpTradeClient (api/_lib/pump.js, which
// resolves the right RPC and the @three-ws/agent-payments build) plus a single
// place that assembles, signs with the AGENT's keypair, and broadcasts — now
// through the MEV-aware execution engine (api/_lib/execution-engine.js): dynamic
// compute budget, optional Jito bundle with an adaptive tip, simulate-then-send
// with bounded adaptive retry, and honest landing telemetry.

import { getPumpTradeClient } from '../../api/_lib/pump.js';
import { submitProtected } from '../../api/_lib/execution-engine.js';

let _ctx = null;

/** Lazily build (and reuse) the trade client + connection for a network. */
export async function getTradeCtx(network) {
	if (_ctx && _ctx.network === network) return _ctx;
	const { client, connection, BN, web3 } = await getPumpTradeClient({ network });
	_ctx = { network, client, connection, BN, web3 };
	return _ctx;
}

/**
 * Assemble, sign, and broadcast a trade through the MEV-aware execution engine,
 * returning the FULL execution telemetry. Use this when the caller wants to
 * persist route/tip/fee/landed_ms (executeBuy does); `signAndSend` wraps this and
 * returns only the signature for callers that don't (executeSell).
 *
 * @param {object} ctx        result of getTradeCtx
 * @param {import('@solana/web3.js').Keypair} payer
 * @param {import('@solana/web3.js').TransactionInstruction[]} instructions
 * @param {number} confirmTimeoutMs
 * @param {object} [opts]      forwarded to submitProtected (tipMode, onTip, preSimulated)
 * @returns {Promise<{ signature, slot, route, tipLamports, priorityFeeMicroLamports, attempts, landedMs, fallbackReason }>}
 */
export async function submitProtectedTrade(ctx, payer, instructions, confirmTimeoutMs, opts = {}) {
	return submitProtected({
		network: ctx.network,
		connection: ctx.connection,
		payer,
		instructions,
		opts: { confirmTimeoutMs, ...opts },
	});
}

/**
 * Broadcast a trade and wait for confirmation. Returns the signature only — the
 * stable contract every caller (notably executeSell) relies on. Internally this
 * routes through the same protected execution engine as the buy path, so sells
 * also get the dynamic compute budget and adaptive retry; sells just don't pay a
 * Jito tip (tipMode defaults to 'off') and don't persist the telemetry.
 *
 * @param {object} ctx        result of getTradeCtx
 * @param {import('@solana/web3.js').Keypair} payer
 * @param {import('@solana/web3.js').TransactionInstruction[]} instructions
 * @param {number} confirmTimeoutMs
 * @param {object} [opts]     optional execution opts (tipMode, onTip)
 * @returns {Promise<string>} the transaction signature
 */
export async function signAndSend(ctx, payer, instructions, confirmTimeoutMs, opts = {}) {
	const result = await submitProtectedTrade(ctx, payer, instructions, confirmTimeoutMs, opts);
	return result.signature;
}
