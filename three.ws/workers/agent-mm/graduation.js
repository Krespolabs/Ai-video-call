// agent-mm — curve → AMM graduation transition.
//
// When a managed coin graduates off the bonding curve onto the canonical pump
// AMM pool, the engine runs the policy's configured graduation_action exactly
// once, so no inventory is left parked in the transition:
//
//   provide_lp  — deposit the managed inventory (paired with the SOL it requires)
//                 into the canonical AMM pool as real LP, using the SAME pool
//                 resolution + PumpAmmSdk the rest of the platform uses. Signed
//                 from the agent wallet through the protected execution engine.
//   distribute  — liquidate the managed inventory back to SOL in the agent wallet
//                 (returned to the owner for withdrawal/distribution). Routed
//                 through executeAgentTrade by the engine — no new fund path.
//   hold        — keep the inventory; the maker simply continues two-sided on the
//                 AMM. Records the handoff and returns control to the engine.
//
// Honest logging at each step; a failure is recorded and retried next sweep
// (never silently swallowed, never double-applied).

import { getAmmPoolState, getConnection } from '../../api/_lib/pump.js';
import { submitProtected } from '../../api/_lib/execution-engine.js';
import { recoverSolanaAgentKeypair } from '../../api/_lib/agent-wallet.js';
import { SOL } from './market.js';

// Leave enough SOL behind to cover rent + fees after pairing the LP deposit.
const SOL_HEADROOM_LAMPORTS = 5_000_000n; // 0.005 SOL

/**
 * Provide LP into the canonical AMM pool from the agent wallet. Deposits the
 * managed inventory paired with the SOL the pool requires, scaling the base down
 * if the wallet can't cover the full pair (so it always deposits the largest
 * balanced amount it can afford rather than failing). LIVE only — caller gates on
 * mode and passes simulate=true to dry-run the build without broadcasting.
 *
 * @returns {Promise<{ signature:string|null, baseDeposited:string, quoteLamports:string, simulated:boolean }>}
 */
export async function provideLp({ network, mint, meta, userId, agentId, inventoryRaw, walletLamports, slippagePct, confirmTimeoutMs, simulate }) {
	const [{ PumpAmmSdk, OnlinePumpAmmSdk }, BNmod] = await Promise.all([
		import('@pump-fun/pump-swap-sdk'),
		import('bn.js').then((m) => m.default || m),
	]);
	const BN = BNmod;
	const connection = getConnection({ network });

	const amm = await getAmmPoolState({ network, mint }); // throws pool_not_found if not graduated
	const offline = new PumpAmmSdk();
	const online = new OnlinePumpAmmSdk(connection);

	const ownerKeypair = await recoverSolanaAgentKeypair(meta.encrypted_solana_secret, {
		agentId, userId, reason: 'mm:graduation_lp', meta: { mint, network, venue: 'lp' },
	});
	const ownerPk = ownerKeypair.publicKey;

	const liqState = await online.liquiditySolanaState(amm.poolKey, ownerPk);

	let base = new BN(BigInt(inventoryRaw).toString());
	if (base.lten(0)) {
		const e = new Error('no inventory to provide as LP');
		e.code = 'no_inventory';
		throw e;
	}

	// How much SOL the full inventory deposit would require, then scale down to fit
	// the wallet's spendable SOL (minus headroom) so we deposit the largest
	// balanced pair we can actually afford.
	let auto = offline.depositAutocompleteQuoteAndLpTokenFromBase(liqState, base, slippagePct);
	const spendable = BigInt(walletLamports) > SOL_HEADROOM_LAMPORTS ? BigInt(walletLamports) - SOL_HEADROOM_LAMPORTS : 0n;
	let requiredQuote = BigInt(auto.quote.toString());
	if (requiredQuote > spendable) {
		if (spendable <= 0n) {
			const e = new Error('insufficient SOL to pair any LP deposit');
			e.code = 'insufficient_sol';
			throw e;
		}
		// Scale base proportionally to the affordable quote, then recompute exactly.
		const scaled = (BigInt(base.toString()) * spendable) / requiredQuote;
		base = new BN(scaled.toString());
		if (base.lten(0)) {
			const e = new Error('scaled LP deposit rounds to zero');
			e.code = 'insufficient_sol';
			throw e;
		}
		auto = offline.depositAutocompleteQuoteAndLpTokenFromBase(liqState, base, slippagePct);
		requiredQuote = BigInt(auto.quote.toString());
	}

	const instructions = await offline.depositInstructions(liqState, auto.lpToken, slippagePct);

	if (simulate) {
		return { signature: null, baseDeposited: base.toString(), quoteLamports: requiredQuote.toString(), simulated: true };
	}

	const result = await submitProtected({
		network, connection, payer: ownerKeypair, instructions,
		opts: { confirmTimeoutMs, tipMode: 'off' },
	});
	return { signature: result.signature, baseDeposited: base.toString(), quoteLamports: requiredQuote.toString(), simulated: false };
}

export { SOL_HEADROOM_LAMPORTS };
