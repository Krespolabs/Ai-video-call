// @ts-check
// api/_lib/x402/agents/onchain.js
//
// One real on-chain program interaction, in the ring rotation, at low cadence
// (Task 09 step 4 — "on-chain deployments being utilized").
//
// What it does: at most once every X402_RING_ONCHAIN_EVERY_N_TICKS ticks (default
// 60 ≈ hourly at a 1/min cadence), one roster agent records a genuine agent-to-
// agent invocation receipt on the `agent_invocation` Anchor program
// (api/_lib/agent-invocation-onchain.js → recordInvocationReceipt). The invoking
// agent's own custodial keypair signs and pays the (tiny) network fee — so the
// FEE PAYER IS A RING WALLET, exactly as the brief requires. The program moves no
// funds and grants no capability; it emits a SkillInvoked event, giving the ring a
// permanent, explorer-linkable proof that two platform agents transacted.
//
// Why this program (not the skill-license mint): invoke_skill's accounts are
// UncheckedAccount PDAs constrained only by seeds — no prior registration, no rent-
// bearing init, and the single required signer is the fee payer. That lets a roster
// wallet BE the fee payer with one signature; the license mint is minter-signed and
// rent-bearing, which would put the fee on the minter, not a ring wallet.
//
// Safety rails (all fail-CLOSED / skip-clean, never throw into the tick):
//   • cadence gate — only fires on the Nth tick.
//   • env gate — needs AGENT_INVOCATION_PROGRAM_ID; runs on AGENT_INVOCATION_NETWORK
//     (default 'devnet' here — no new mainnet program calls, per the constraints).
//   • deploy gate — verifies the program is executable on that cluster first; if
//     not deployed, records a clean skip.
//   • rent bound — invoke_skill allocates no account, so there is no rent to bound
//     beyond the base fee (~5000 lamports), which the roster wallet pays.
//
// Every attempt (landed or skipped) is logged to x402_autonomous_log (pipeline
// 'ring-onchain', agent_id = invoker) and, on success, a custody event — so the
// on-chain activity is visibly attributed just like the USDC purchases.

import { PublicKey } from '@solana/web3.js';

import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { solanaConnection } from '../../solana/connection.js';
import { recordCustodyEvent } from '../../agent-trade-guards.js';
import { isOnchainTick } from './persona-math.js';
import {
	recordInvocationReceipt,
	AGENT_INVOCATION_PROGRAM_ID,
} from '../../agent-invocation-onchain.js';

// Re-export the pure cadence gate so callers/tests can import it from here.
export { isOnchainTick };

const log = logger('x402-ring-onchain');

/** Ticks between on-chain interactions. Default 60. Set 0 to disable entirely. */
export function onchainEveryNTicks() {
	const n = Number(process.env.X402_RING_ONCHAIN_EVERY_N_TICKS ?? 60);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60;
}

/** The cluster the on-chain receipt lands on. Devnet by default — the constraints
 *  forbid new mainnet program calls in this task. */
export function onchainNetwork() {
	return process.env.AGENT_INVOCATION_NETWORK === 'mainnet' ? 'mainnet' : 'devnet';
}

/**
 * Maybe land one on-chain agent-invocation receipt this tick.
 *
 * @param {object} p
 * @param {Function} p.sql
 * @param {Array<{ persona: object, id: string, name: string, address: string, user_id: string|null, meta: object }>} p.roster
 * @param {number} p.seed
 * @param {string} p.runId
 * @param {(row: object) => Promise<import('@solana/web3.js').Keypair|null>} p.recoverAgentBuyer
 * @returns {Promise<{ attempted: boolean, landed: boolean, signature?: string, explorer?: string,
 *   invoker?: string, target?: string, network?: string, reason?: string }>}
 */
export async function maybeRecordOnchainReceipt({ sql, roster, seed, runId, recoverAgentBuyer }) {
	const everyN = onchainEveryNTicks();
	if (!isOnchainTick(seed, everyN)) {
		return { attempted: false, landed: false, reason: `not_onchain_tick(every_${everyN})` };
	}
	if (!AGENT_INVOCATION_PROGRAM_ID) {
		return { attempted: false, landed: false, reason: 'program_id_unset' };
	}
	if (!Array.isArray(roster) || roster.length < 2) {
		// Need a distinct invoker + target to record an agent-to-agent receipt.
		return { attempted: false, landed: false, reason: 'need_two_roster_agents' };
	}

	const network = onchainNetwork();

	// Deterministically pick invoker + a distinct target from the roster.
	const invokerMember = roster[(seed >>> 0) % roster.length];
	const targetMember = roster[((seed >>> 0) + 1) % roster.length];

	const conn = solanaConnection({ network, commitment: 'confirmed' });

	// Deploy gate — only attempt if the program is actually executable on this
	// cluster. Absent/unfunded env is a clean skip, not a failure.
	try {
		const info = await conn.getAccountInfo(new PublicKey(AGENT_INVOCATION_PROGRAM_ID));
		if (!info || !info.executable) {
			await recordOnchainAttempt(sql, runId, invokerMember, { landed: false, network, reason: 'program_not_deployed' });
			return { attempted: true, landed: false, network, reason: 'program_not_deployed' };
		}
	} catch (err) {
		return { attempted: true, landed: false, network, reason: `rpc_probe_failed:${String(err?.message || err).slice(0, 80)}` };
	}

	const invokerKeypair = await recoverAgentBuyer(invokerMember);
	if (!invokerKeypair) {
		return { attempted: true, landed: false, network, reason: 'invoker_key_unavailable' };
	}

	let receipt;
	try {
		receipt = await recordInvocationReceipt({
			invokerKeypair,
			targetAuthority: targetMember.address,
			skillName: `ring:${invokerMember.persona.id}->${targetMember.persona.id}`.slice(0, 64),
			parameters: JSON.stringify({ ring: true, tick_seed: seed, run_id: runId }).slice(0, 512),
			network,
			connection: conn,
		});
	} catch (err) {
		// Unfunded invoker on devnet, RPC hiccup, program mismatch — clean skip.
		const reason = String(err?.message || err).slice(0, 140);
		await recordOnchainAttempt(sql, runId, invokerMember, { landed: false, network, reason });
		return { attempted: true, landed: false, network, reason };
	}

	// Landed. Attribute it: log row + custody event on the invoker.
	await recordOnchainAttempt(sql, runId, invokerMember, {
		landed: true, network,
		signature: receipt.signature, explorer: receipt.explorer,
		target: targetMember.address,
	});
	await recordCustodyEvent({
		agentId: invokerMember.id,
		userId: invokerMember.user_id ?? null,
		eventType: 'onchain_event',
		network,
		signature: receipt.signature,
		reason: 'ring_invocation_receipt',
		status: 'confirmed',
		meta: {
			internal: true, program: receipt.programId,
			target_agent: targetMember.id, target_persona: targetMember.persona.id,
			explorer: receipt.explorer,
		},
	}).catch(() => {});

	log.info('ring_onchain_receipt_landed', {
		signature: receipt.signature, network,
		invoker: invokerMember.persona.id, target: targetMember.persona.id,
	});

	return {
		attempted: true, landed: true, network,
		signature: receipt.signature, explorer: receipt.explorer,
		invoker: invokerMember.address, target: targetMember.address,
	};
}

/** Log an on-chain attempt (landed or skipped) to x402_autonomous_log for the feed. */
async function recordOnchainAttempt(sql, runId, invokerMember, { landed, network, signature = null, explorer = null, target = null, reason = null }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, agent_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 signal_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${invokerMember.id}, 'self',
				 ${`ring-onchain:${invokerMember.persona.id}`},
				 ${`agent_invocation:${AGENT_INVOCATION_PROGRAM_ID}`},
				 ${`solana:${network}`}, 0, ${'SOL'}, ${signature},
				 ${JSON.stringify({ persona: invokerMember.persona.id, internal: true, onchain: true, network })},
				 ${JSON.stringify({ landed, explorer, target, program: AGENT_INVOCATION_PROGRAM_ID })},
				 0, ${landed}, ${reason}, 'ring-onchain')
		`;
	} catch (err) {
		log.warn('onchain_log_failed', { message: err?.message });
	}
}
