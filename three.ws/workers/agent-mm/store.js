// agent-mm — policy reads + runtime state writes for the engine.
//
// Thin layer over the shared model (api/_lib/market-maker.js): the worker reads
// the active policy set, loads each agent's wallet meta, records every action to
// the transparent ledger, and advances the policy's runtime aggregates (realized
// PnL, deployed/recovered SOL, inventory snapshot, last-action stamps). Single-
// worker assumption (documented, mirrors agent-sniper/agent-orders): per-policy
// state is serialized in-process; the custody idempotency_key on each fill is the
// real cross-process double-spend backstop.

import { sql } from '../../api/_lib/db.js';
import { recordAction } from '../../api/_lib/market-maker.js';

export { getActivePolicies, getDeployedLamports24h, getDefenseLamports24h } from '../../api/_lib/market-maker.js';

/** Load (and lightly cache by the caller) an agent's meta + user for execution. */
export async function loadAgent(agentId) {
	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!row) return null;
	return { id: row.id, userId: row.user_id, meta: { ...(row.meta || {}) } };
}

/** Persist the per-sweep observation (price + inventory snapshot), fired or not. */
export async function markEvaluated(policyId, { priceSol = null, inventoryTokens = null, inventoryValueLamports = null, error = null } = {}) {
	await sql`
		UPDATE market_maker_policies SET
			last_eval_at = now(),
			last_price_sol = COALESCE(${priceSol}, last_price_sol),
			inventory_tokens = COALESCE(${inventoryTokens}, inventory_tokens),
			inventory_value_lamports = COALESCE(${inventoryValueLamports != null ? String(inventoryValueLamports) : null}, inventory_value_lamports),
			last_error = ${error}
		WHERE id = ${policyId}
	`;
}

/**
 * Record a material action to the ledger AND advance the policy's runtime
 * aggregates in one place. `effect.solLamports` is the gross SOL moved by the
 * fill. Realized PnL is tracked as honest NET CASH FLOW (recovered − deployed):
 * a buy deploys SOL (realized −=), a sell recovers SOL (realized +=). Combined
 * with the live inventory value the UI shows, total = realized + inventory_value.
 * Skips/blocked/failed actions are logged but never move aggregates.
 */
export async function recordActionAndAdvance({ policy, action, effect = null }) {
	const row = await recordAction({
		policyId: policy.id, mint: policy.mint, network: policy.network, ...action,
	});

	const material = ['executed', 'simulated'].includes(action.status) && (action.side === 'buy' || action.side === 'sell');
	if (!material) return row;

	const sol = BigInt(Math.max(0, Math.round(Number(effect?.solLamports || 0))));
	if (action.side === 'buy') {
		await sql`
			UPDATE market_maker_policies SET
				sol_deployed_lamports = sol_deployed_lamports + ${String(sol)},
				realized_pnl_lamports = realized_pnl_lamports - ${String(sol)},
				last_action_at = now(), last_action_side = 'buy', updated_at = now()
			WHERE id = ${policy.id}
		`;
	} else {
		await sql`
			UPDATE market_maker_policies SET
				sol_recovered_lamports = sol_recovered_lamports + ${String(sol)},
				realized_pnl_lamports = realized_pnl_lamports + ${String(sol)},
				last_action_at = now(), last_action_side = 'sell', updated_at = now()
			WHERE id = ${policy.id}
		`;
	}
	return row;
}

/** Stamp the seed as done so it never fires twice. */
export async function markSeedDone(policyId) {
	await sql`UPDATE market_maker_policies SET seed_done_at = now() WHERE id = ${policyId} AND seed_done_at IS NULL`;
}

/**
 * Mark the graduation transition complete (or failed). On a terminal action
 * (provide_lp / distribute) the policy moves to 'graduated' and disables further
 * active trading; 'hold' records the handoff but keeps the maker two-sided on the
 * AMM. Always advances graduation_done_at so the transition runs exactly once.
 */
export async function markGraduation(policyId, { status, signature = null, terminal = false }) {
	if (terminal) {
		await sql`
			UPDATE market_maker_policies SET
				graduation_done_at = now(), graduation_status = ${status}, graduation_signature = ${signature},
				status = 'graduated', enabled = false, updated_at = now()
			WHERE id = ${policyId}
		`;
		return;
	}
	await sql`
		UPDATE market_maker_policies SET
			graduation_done_at = now(), graduation_status = ${status}, graduation_signature = ${signature},
			updated_at = now()
		WHERE id = ${policyId}
	`;
}
