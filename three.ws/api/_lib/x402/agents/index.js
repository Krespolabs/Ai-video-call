// @ts-check
// api/_lib/x402/agents/index.js
//
// The agent-buyer roster + the ring-tick driver (Task 09).
//
// This is what turns the closed-loop ring from "a cron paying itself" into an
// agent-to-agent economy: a handful of REAL platform agents (agent_identities rows
// with custodial Solana wallets) each shop the ring every tick, in character, with
// their spend limits enforced and every purchase attributed to them.
//
// Pieces:
//   • PERSONAS               — the persona modules (endpoint-shopper, agora-citizen,
//                              curator), each a description of what one agent buys.
//   • ensureRosterAgents()   — idempotently resolve/create the backing agent
//                              identities, provision their custodial wallets
//                              (ensureAgentWallet), stamp their spend limits, and
//                              register them in x402_ring_wallets(role='agent') so
//                              they land inside ringAllowedAddresses() (Task 06) and
//                              the ring verify script (Task 03) automatically.
//   • selectPersonasForTick()— deterministic persona selection from a tick seed.
//   • run(ctx)               — the driver the autonomous loop invokes as an
//                              alternative buyer set: resolve roster → plan →
//                              guarded settle (persona-kit.executePurchase) → record
//                              each purchase to x402_autonomous_log WITH agent_id →
//                              at low cadence, land one real on-chain program call.
//
// Wiring: registered in autonomous-registry.js as the `agent-buyers` run()-entry;
// the per-tick loop hands it { origin, buyer, conn, blockhash, mintInfo, redis,
// sql, runId, remainingCap }. Standalone callers (scripts/x402-ring-agents-run.mjs)
// pass the same shape.
//
// Money invariant: buyers are platform-controlled custodial wallets; every payTo is
// the ring treasury; the on-chain fee payer is a roster (ring) wallet. USDC only.
// Personas are labeled internal in every log row — never organic users.

import { randomUUID } from 'node:crypto';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { ensureAgentWallet } from '../../agent-wallet.js';
import { ringAllowedAddresses } from '../ring-allowlist.js';
import { bootstrapSolanaContext, USDC_MINT } from '../pay.js';
import {
	executePurchase,
	recoverAgentBuyer,
	seedFromString,
	usdcConfigured,
	treasuryPubkey,
} from './persona-kit.js';
import { maybeRecordOnchainReceipt } from './onchain.js';

import { persona as endpointShopper } from './endpoint-shopper.js';
import { persona as agoraCitizen } from './agora-citizen.js';
import { persona as curator } from './curator.js';

const log = logger('x402-ring-agents');

/** The roster's personas, in stable order. Add a persona module + one import here. */
export const PERSONAS = [endpointShopper, agoraCitizen, curator];

// How many purchases each active persona makes per tick (bounds per-tick spend on
// top of the loop's caps). Default 1 — one buy per agent per minute.
const MAX_BUYS_PER_PERSONA = Math.max(1, Number(process.env.X402_RING_AGENT_MAX_BUYS_PER_TICK || 1));

// How many personas act per tick. Default = all of them (so every roster agent
// buys each minute → ≥3 distinct agent_ids per tick). Set < PERSONAS.length to
// rotate a deterministic window instead.
function personasPerTick() {
	const n = Number(process.env.X402_RING_AGENT_PERSONAS_PER_TICK || PERSONAS.length);
	return Math.max(1, Math.min(PERSONAS.length, n));
}

/**
 * Deterministically select which personas act on a given tick. When the window
 * equals the roster size (default) all personas act, in order. Otherwise it
 * rotates a contiguous window by seed so every persona gets equal airtime.
 * Pure — no I/O — so selection is reproducible and unit-testable.
 * @param {number} seed
 * @param {{ personas?: Array, window?: number }} [opts]
 * @returns {Array}
 */
export function selectPersonasForTick(seed, { personas = PERSONAS, window = personasPerTick() } = {}) {
	const w = Math.max(1, Math.min(personas.length, window));
	if (w >= personas.length) return personas.slice();
	const start = (seed >>> 0) % personas.length;
	const out = [];
	for (let i = 0; i < w; i++) out.push(personas[(start + i) % personas.length]);
	return out;
}

// ── Roster provisioning ────────────────────────────────────────────────────────

/** Resolve the owner user_id for roster agents: env override, else reuse an
 *  existing agent's owner (roster agents are platform-operated circulation agents,
 *  not a specific human's). Returns null when neither is available. */
async function resolveOwnerUserId(sql) {
	const envId = process.env.X402_RING_AGENT_OWNER_USER_ID;
	if (envId) return envId;
	try {
		const [row] = await sql`
			SELECT user_id FROM agent_identities
			WHERE user_id IS NOT NULL AND deleted_at IS NULL
			ORDER BY created_at ASC LIMIT 1
		`;
		return row?.user_id || null;
	} catch {
		return null;
	}
}

/** Merge the persona's spend limits into an agent meta blob (idempotent). */
function withPersonaMeta(meta, persona) {
	const next = { ...(meta || {}) };
	next.ring_persona = persona.id;
	next.circulation = 'true'; // platform-operated, not a human's agent
	next.spend_limits = { ...(next.spend_limits || {}), ...persona.spendLimits };
	return next;
}

/**
 * Idempotently resolve (and, when possible, create) the backing agent identity for
 * one persona: find by meta.ring_persona, else create; provision the custodial
 * Solana wallet; stamp spend limits + persona meta; register in x402_ring_wallets.
 * Returns the resolved roster member, or null when it can't be provisioned in this
 * environment (no DB, no owner to create under) — the driver simply skips it.
 *
 * @returns {Promise<{ persona: object, id: string, name: string, address: string,
 *   user_id: string|null, meta: object }|null>}
 */
export async function ensureRosterAgent(sql, persona) {
	// 1 — find an existing agent tagged with this persona.
	let row;
	try {
		[row] = await sql`
			SELECT id, user_id, name, meta FROM agent_identities
			WHERE meta->>'ring_persona' = ${persona.id} AND deleted_at IS NULL
			ORDER BY created_at ASC LIMIT 1
		`;
	} catch (err) {
		log.warn('roster_lookup_failed', { persona: persona.id, message: err?.message });
		return null;
	}

	// 2 — create it if absent (needs an owner to attach to).
	if (!row) {
		const ownerId = await resolveOwnerUserId(sql);
		if (!ownerId) {
			log.info('roster_no_owner', { persona: persona.id, note: 'set X402_RING_AGENT_OWNER_USER_ID to provision' });
			return null;
		}
		const meta = withPersonaMeta({ internal: true }, persona);
		try {
			[row] = await sql`
				INSERT INTO agent_identities (user_id, name, description, skills, meta)
				VALUES (${ownerId}, ${persona.agentName}, ${persona.describe},
				        ${['x402-buy', 'ring-participant']}, ${JSON.stringify(meta)}::jsonb)
				RETURNING id, user_id, name, meta
			`;
			log.info('roster_agent_created', { persona: persona.id, agent_id: row.id });
		} catch (err) {
			log.warn('roster_create_failed', { persona: persona.id, message: err?.message });
			return null;
		}
	}

	// 3 — provision the custodial Solana wallet (idempotent) + reload meta.
	let address = row.meta?.solana_address || null;
	try {
		const w = await ensureAgentWallet(row.id, row.user_id ?? null, { reason: 'ring_roster_provision' });
		address = w.address;
	} catch (err) {
		log.warn('roster_wallet_failed', { persona: persona.id, message: err?.message });
	}

	// 4 — ensure spend limits + persona meta are stamped (idempotent update). Reload
	//     the row so meta carries the freshly-provisioned encrypted_solana_secret.
	let meta = row.meta || {};
	try {
		const [fresh] = await sql`SELECT meta FROM agent_identities WHERE id = ${row.id} LIMIT 1`;
		meta = withPersonaMeta(fresh?.meta || meta, persona);
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${row.id}`;
	} catch (err) {
		log.warn('roster_meta_update_failed', { persona: persona.id, message: err?.message });
	}

	// 5 — register in x402_ring_wallets(role='agent') so the wallet is inside
	//     ringAllowedAddresses() and the ring verify script. Best-effort.
	if (address) {
		try {
			await sql`
				INSERT INTO x402_ring_wallets (pubkey, label, role, enabled, note)
				VALUES (${address}, ${`agent:${persona.id}`}, 'agent', true, ${`roster persona ${persona.id} (agent ${row.id})`})
				ON CONFLICT (pubkey) DO UPDATE SET label = EXCLUDED.label, role = 'agent', enabled = true, note = EXCLUDED.note
			`;
		} catch (err) {
			log.warn('roster_registry_upsert_failed', { persona: persona.id, message: err?.message });
		}
	}

	if (!address) return null;
	return { persona, id: row.id, name: row.name, address, user_id: row.user_id ?? null, meta };
}

/** Resolve the whole roster (idempotent). Members that can't be provisioned in
 *  this environment are dropped, never faked. */
export async function ensureRosterAgents(sql = defaultSql) {
	const out = [];
	for (const persona of PERSONAS) {
		const member = await ensureRosterAgent(sql, persona);
		if (member) out.push(member);
	}
	return out;
}

// ── Per-call attribution log ───────────────────────────────────────────────────

let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	// agent_id attribution column (mirrors the migration; idempotent so a warm
	// instance is safe before the migration file is applied).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS agent_id uuid`;
	await sql`CREATE INDEX IF NOT EXISTS x402_autonomous_log_agent_ts ON x402_autonomous_log (agent_id, ts DESC)`;
	_schemaReady = true;
}

/** One attributed row per persona purchase. agent_id is what makes the ring feed
 *  read as an agent economy, not a cron. */
async function recordAgentPurchase(sql, runId, outcome, { endpointUrl }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, agent_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 signal_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${outcome.agentId}, 'self',
				 ${`ring-agent:${outcome.persona}:${outcome.slug}`}, ${endpointUrl},
				 'solana:mainnet', ${outcome.amountAtomic || 0},
				 ${USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},
				 ${outcome.txSig || null},
				 ${JSON.stringify({ persona: outcome.persona, kind: outcome.kind, internal: true, status: outcome.status })},
				 ${JSON.stringify({ payTo: outcome.payTo, liveness: outcome.responseLiveness, reason: outcome.reason })},
				 ${outcome.durationMs || 0}, ${outcome.status === 'paid' || outcome.status === 'free'},
				 ${outcome.reason || null}, 'ring-agents')
		`;
	} catch (err) {
		log.warn('agent_purchase_log_failed', { persona: outcome.persona, slug: outcome.slug, message: err?.message });
	}
}

// ── Driver ─────────────────────────────────────────────────────────────────────

/** Read + advance the monotonic tick counter (Redis), or derive a stable seed from
 *  the runId when Redis is absent. Seed drives deterministic persona/endpoint choice. */
async function nextTickSeed(redis, runId) {
	if (redis) {
		try {
			const n = Number(await redis.incr('x402:ring:agent:tick'));
			if (Number.isFinite(n)) return n >>> 0;
		} catch { /* fall through to runId-derived seed */ }
	}
	return seedFromString(runId || randomUUID());
}

/**
 * Ring agent-buyer tick. Conforms to the run()-style registry contract.
 * Returns the aggregate outcome the loop records as ONE summary row; the granular
 * per-purchase rows (with agent_id) are self-recorded here, so `recorded:true`.
 *
 * @param {object} ctx { origin, buyer, conn, blockhash, mintInfo, redis, sql, runId, remainingCap }
 */
export async function run(ctx = {}) {
	const sql = ctx.sql || defaultSql;
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const redis = ctx.redis || null;

	if (!usdcConfigured()) {
		return { success: true, skipped: true, recorded: true, amountAtomic: 0, note: 'usdc_mint_unset' };
	}
	const treasury = treasuryPubkey();
	if (!treasury) {
		return { success: true, skipped: true, recorded: true, amountAtomic: 0, note: 'treasury_unset' };
	}

	try {
		await ensureSchema(sql);
	} catch (err) {
		return { success: false, skipped: true, recorded: true, amountAtomic: 0, errorMsg: `schema_failed:${err?.message}` };
	}

	// Resolve the roster (idempotent provision). Empty → nothing to drive.
	const roster = await ensureRosterAgents(sql);
	if (roster.length === 0) {
		return { success: true, skipped: true, recorded: true, amountAtomic: 0, note: 'no_roster_agents' };
	}

	// Shared Solana context: reuse the loop's, else bootstrap standalone.
	let { conn, blockhash, mintInfo } = ctx;
	if (!conn || !blockhash || !mintInfo) {
		try {
			({ conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer: ctx.buyer }));
		} catch (err) {
			return { success: false, skipped: true, recorded: true, amountAtomic: 0, errorMsg: `solana_ctx_failed:${err?.message}`, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	// The controlled-wallet set — resolved once per tick and shared across every
	// purchase's payTo check. Roster wallets are already in it (registered above).
	const allowed = await ringAllowedAddresses({ sql });

	const seed = await nextTickSeed(redis, runId);
	const active = selectPersonasForTick(seed);

	let remaining = ctx.remainingCap ?? Number.POSITIVE_INFINITY;
	let spentAtomic = 0;
	let paid = 0;
	let refused = 0;
	let errors = 0;
	let lastTxSig = null;
	const purchases = [];

	for (const persona of active) {
		const member = roster.find((m) => m.persona.id === persona.id);
		if (!member) continue;

		const keypair = await recoverAgentBuyer(member);
		if (!keypair) {
			log.info('roster_key_unavailable', { persona: persona.id });
			continue;
		}
		const agent = { id: member.id, name: member.name, address: member.address, keypair, meta: member.meta, userId: member.user_id ?? null };

		// Persona-specific, seed-deterministic plan for this tick.
		const plan = persona.plan({ origin, seed, maxBuys: MAX_BUYS_PER_PERSONA });
		for (const purchase of plan) {
			if (remaining <= 0) break;
			const outcome = await executePurchase({
				agent, purchase, persona: persona.id, allowed,
				solana: { conn, blockhash, mintInfo },
				remainingCap: remaining,
			});
			await recordAgentPurchase(sql, runId, outcome, { endpointUrl: purchase.url });

			if (outcome.status === 'paid') {
				paid += 1;
				spentAtomic += outcome.amountAtomic;
				remaining -= outcome.amountAtomic;
				if (outcome.txSig) lastTxSig = outcome.txSig;
			} else if (outcome.status === 'refused') {
				refused += 1;
			} else if (outcome.status === 'error') {
				errors += 1;
			}
			purchases.push({ persona: persona.id, slug: purchase.slug, status: outcome.status, agent_id: agent.id, tx: outcome.txSig });
		}
	}

	// Low-cadence on-chain program call (agent-invocation receipt). Bounded by
	// X402_RING_ONCHAIN_EVERY_N_TICKS; fee payer is a roster (ring) wallet; skips
	// cleanly when the program/env is absent or unfunded.
	let onchain = null;
	try {
		onchain = await maybeRecordOnchainReceipt({ sql, roster, seed, runId, recoverAgentBuyer });
	} catch (err) {
		onchain = { attempted: true, landed: false, reason: `onchain_error:${String(err?.message || err).slice(0, 120)}` };
	}

	log.info('ring_agents_tick_complete', {
		run_id: runId, seed, active: active.length, roster: roster.length,
		paid, refused, errors, spent_usdc: (spentAtomic / 1e6).toFixed(4),
		onchain: onchain?.landed ? onchain.signature : (onchain?.reason || 'skipped'),
	});

	return {
		success: paid > 0 || purchases.length > 0,
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		recorded: true, // granular per-purchase rows already written (with agent_id)
		skipped: purchases.length === 0,
		signalData: { seed, active: active.map((p) => p.id), paid, refused, errors, onchain },
		responseData: { purchases, onchain },
		note: `ring_agents paid=${paid} refused=${refused} errors=${errors}` + (onchain?.landed ? ` onchain=${onchain.signature}` : ''),
	};
}
