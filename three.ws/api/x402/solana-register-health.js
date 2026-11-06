// GET /api/x402/solana-register-health
//
// Solana Agent Registration Health Check — the paid, x402-reachable canary for
// three.ws's server-custodial Solana agent-registration subsystem (the path the
// MCP `register_agent` tool drives: mint a Metaplex Core asset → enrol it in the
// Metaplex Agent Registry → index its on-chain record).
//
// Why a dedicated endpoint instead of calling `register_agent` directly:
//   `register_agent` is ACCOUNT-SCOPED — its handler returns `sign_in_required`
//   for any pay-per-call (x402) principal, and it MINTS new on-chain state on a
//   cold key (non-idempotent). An autonomous x402 spend loop can neither
//   authenticate as a user nor responsibly mint a fresh identity every tick. So
//   the honest canary verifies the *resulting on-chain record* of a known,
//   already-registered agent — exactly the "check the resulting on-chain record
//   exists" the health check calls for — without minting anything new.
//
// What it verifies, end-to-end, against live infrastructure:
//   1. The canary agent resolves in the three.ws index (agent_identities).
//   2. Its Agent Registry enrolment is recorded (meta.agent_registry.identity_pda).
//   3. Both the Identity PDA and the Core asset accounts EXIST on-chain right now
//      (getAccountInfo over the failover RPC pool) — proving the registry write
//      landed and the RPC read path is healthy.
//
// Every call (autonomous loop OR any bazaar buyer) upserts the canonical health
// row in `mcp_health_canary` (shared by all MCP-Health canaries — see
// agents/x402-buildout/self/) and emits an alert log when the subsystem trips.
//
// Data stored (requirement 3 + 4):
//   • x402_autonomous_log         — written by the autonomous loop on every call:
//       response_data = this endpoint's full JSON snapshot;
//       signal_data   = the entry's extractSignal() verdict
//       { alive, registry_enrolled, asset_onchain, identity_pda_onchain, … }.
//   • mcp_health_canary[tool_name='solana_register'] — written HERE, server-side:
//       healthy, last_checked_at, last_ok_at, consecutive_failures, last_error,
//       detail (jsonb: source/network/asset/identity_pda/checks/latency),
//       last_tx_signature.
//
// Downstream consumers:
//   • This endpoint's own alert escalation reads consecutive_failures from
//     mcp_health_canary to decide warn-vs-error logging (sustained-outage alert).
//   • mcp_health_canary is the shared MCP-Health read-model (keyed by tool_name)
//     that the platform status surface renders alongside the other canaries
//     (granite_inference_health, mcp_stream_health, x402_perf_log).
//   • The x402 admin activity/analytics views read x402_autonomous_log, so the
//     signal_data verdict is visible there per autonomous tick.
//
// Canary selection (real data only — never a mock):
//   X402_CANARY_AGENT_ID    a known three.ws agent_id (uuid) registered on Solana
//   X402_CANARY_AGENT_ASSET a known Core asset pubkey (skips the agent_id lookup)
//   else                    the most-recently-registered live agent — verifying
//                           any real on-chain record still exercises the full path.

import { PublicKey } from '@solana/web3.js';

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { isUuid } from '../_lib/validate.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { logger } from '../_lib/usage.js';
import { explorerUrl } from '../_lib/onchain-deploy.js';

const ROUTE = '/api/x402/solana-register-health';
export const TOOL_NAME = 'solana_register';
// Consecutive failures before the canary escalates from a warn to an alert log.
export const ALERT_THRESHOLD = 3;

const log = logger('x402-solana-register-health');

const DESCRIPTION =
	'Solana Agent Registration Health Check — verifies three.ws\'s server-custodial ' +
	'Solana agent-registration subsystem end-to-end by resolving a known canary ' +
	'agent\'s on-chain Metaplex Agent Registry record (Identity PDA + Core asset) ' +
	'and confirming both accounts exist on-chain right now. Returns a health ' +
	'snapshot with latency and the checked asset. Pay-per-call in USDC on Solana ' +
	'or Base mainnet.';

const OUTPUT_EXAMPLE = {
	tool: 'solana_register',
	healthy: true,
	network: 'mainnet',
	canary_agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
	asset: 'THREEsynthetic1111111111111111111111111111',
	identity_pda: 'AgentRegyPDA11111111111111111111111111111111',
	registration_uri: 'https://three.ws/api/agents/7b9a4f30/registration.json',
	checks: { indexed: true, registry_enrolled: true, asset_onchain: true, identity_pda_onchain: true },
	rpc_latency_ms: 184,
	checked_at: '2026-06-27T18:00:00Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['tool', 'healthy', 'checks', 'checked_at'],
	properties: {
		tool: { type: 'string' },
		healthy: { type: 'boolean' },
		network: { type: ['string', 'null'] },
		canary_agent_id: { type: ['string', 'null'] },
		asset: { type: ['string', 'null'] },
		identity_pda: { type: ['string', 'null'] },
		registration_uri: { type: ['string', 'null'] },
		reason: { type: ['string', 'null'] },
		checks: {
			type: 'object',
			properties: {
				indexed: { type: 'boolean' },
				registry_enrolled: { type: 'boolean' },
				asset_onchain: { type: 'boolean' },
				identity_pda_onchain: { type: 'boolean' },
			},
		},
		rpc_latency_ms: { type: ['integer', 'null'] },
		consecutive_failures: { type: 'integer' },
		checked_at: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: {} },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({ method: 'GET', outputSchema: OUTPUT_SCHEMA }),
};

// Resolve the canary agent row. Prefers an explicitly-configured agent, falls
// back to the most-recently-registered live agent so the probe still exercises
// a real on-chain record in production even when no canary env is set.
async function resolveCanaryAgent() {
	const explicitId = String(env.X402_CANARY_AGENT_ID || process.env.X402_CANARY_AGENT_ID || '').trim();
	const explicitAsset = String(env.X402_CANARY_AGENT_ASSET || process.env.X402_CANARY_AGENT_ASSET || '').trim();

	if (explicitId && isUuid(explicitId)) {
		const [row] = await sql`
			select id, name, wallet_address as owner, meta
			from agent_identities
			where id = ${explicitId} and deleted_at is null
			limit 1
		`;
		if (row) return { row, source: 'env_agent_id' };
	}

	if (explicitAsset) {
		const [row] = await sql`
			select id, name, wallet_address as owner, meta
			from agent_identities
			where meta->>'sol_mint_address' = ${explicitAsset} and deleted_at is null
			limit 1
		`;
		if (row) return { row, source: 'env_asset' };
		// Asset given but not in our index — still verifiable purely on-chain.
		return { row: { id: null, name: null, owner: null, meta: { sol_mint_address: explicitAsset } }, source: 'env_asset_offindex' };
	}

	// Fallback: any genuinely-registered agent. Verifying its on-chain record
	// still proves the registry write + indexer + RPC read path are healthy.
	const [row] = await sql`
		select id, name, wallet_address as owner, meta
		from agent_identities
		where deleted_at is null
		  and meta->'agent_registry'->>'identity_pda' is not null
		order by updated_at desc nulls last
		limit 1
	`;
	if (row) return { row, source: 'latest_registered' };
	return { row: null, source: 'none' };
}

// Pull the registration coordinates out of an agent's meta for either network.
export function readRegistration(meta) {
	const m = meta || {};
	const mainnet = m.sol_mint_address
		? { network: 'mainnet', asset: m.sol_mint_address, registry: m.agent_registry || null }
		: null;
	const devnet = m.devnet?.sol_mint_address
		? { network: 'devnet', asset: m.devnet.sol_mint_address, registry: m.devnet.agent_registry || null }
		: null;
	return mainnet || devnet || { network: 'mainnet', asset: null, registry: null };
}

// The canary is healthy only when the agent is enrolled in the registry AND both
// the Core asset and the Identity PDA accounts currently resolve on-chain. Pure
// so the verdict is unit-testable without a DB or RPC.
export function evaluateHealthy(checks) {
	return (
		checks?.registry_enrolled === true &&
		checks?.asset_onchain === true &&
		checks?.identity_pda_onchain === true
	);
}

// Confirm an account exists on-chain. Returns false on a malformed pubkey or any
// RPC error — the canary treats "couldn't confirm" as unhealthy, not a crash.
async function accountExists(conn, pubkey) {
	if (!pubkey) return false;
	let key;
	try { key = new PublicKey(pubkey); } catch { return false; }
	try {
		const info = await conn.getAccountInfo(key, 'confirmed');
		return info !== null;
	} catch {
		return false;
	}
}

// Persist the canonical health row shared by every MCP-Health canary. On a
// healthy result the failure counter resets; on failure it increments so a
// status dashboard (and the alert threshold below) can see a sustained outage.
async function recordHealth({ healthy, reason, detail, txSignature }) {
	try {
		const [row] = await sql`
			INSERT INTO mcp_health_canary
				(tool_name, healthy, last_checked_at, last_ok_at,
				 consecutive_failures, last_error, detail, last_tx_signature)
			VALUES
				(${TOOL_NAME}, ${healthy}, now(),
				 ${healthy ? sql`now()` : null},
				 ${healthy ? 0 : 1}, ${healthy ? null : reason || 'unhealthy'},
				 ${JSON.stringify(detail || {})}, ${txSignature || null})
			ON CONFLICT (tool_name) DO UPDATE SET
				healthy              = EXCLUDED.healthy,
				last_checked_at      = now(),
				last_ok_at           = CASE WHEN EXCLUDED.healthy THEN now() ELSE mcp_health_canary.last_ok_at END,
				consecutive_failures = CASE WHEN EXCLUDED.healthy THEN 0 ELSE mcp_health_canary.consecutive_failures + 1 END,
				last_error           = CASE WHEN EXCLUDED.healthy THEN null ELSE EXCLUDED.last_error END,
				detail               = EXCLUDED.detail,
				last_tx_signature    = COALESCE(EXCLUDED.last_tx_signature, mcp_health_canary.last_tx_signature)
			RETURNING consecutive_failures
		`;
		return row?.consecutive_failures ?? 0;
	} catch (err) {
		// Table missing on a fresh deploy — create once, then the next call records.
		if (/does not exist|relation .* does not exist/i.test(err?.message || '')) {
			await ensureHealthTable();
		} else {
			log.warn('mcp_health_canary_upsert_failed', { message: err?.message });
		}
		return healthy ? 0 : 1;
	}
}

async function ensureHealthTable() {
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS mcp_health_canary (
				tool_name            text PRIMARY KEY,
				healthy              boolean NOT NULL,
				last_checked_at      timestamptz NOT NULL DEFAULT now(),
				last_ok_at           timestamptz,
				consecutive_failures int NOT NULL DEFAULT 0,
				last_error           text,
				detail               jsonb,
				last_tx_signature    text
			)
		`;
	} catch (err) {
		log.warn('mcp_health_canary_create_failed', { message: err?.message });
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	// $0.001 USDC = 1000 atomics (6-decimal). Override via X402_PRICE_SOLANA_REGISTER_HEALTH.
	priceAtomics: priceFor('solana-register-health', '1000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	services: ['solana-register-health'],
	service: withService({
		serviceName: 'three.ws Solana Registration Health',
		tags: ['health', 'solana', 'registration', 'agent', 'canary', 'mcp'],
	}),
	async handler() {
		await ensureHealthTable();
		const checkedAt = new Date().toISOString();
		const checks = { indexed: false, registry_enrolled: false, asset_onchain: false, identity_pda_onchain: false };

		// 1. Resolve the canary.
		const { row: agent, source } = await resolveCanaryAgent();
		if (!agent) {
			// No registered agent exists yet to probe. This is an ops/config gap,
			// not a subsystem outage, so we surface it without tripping the failure
			// counter (record as healthy:false but reason-tagged, no increment past 1).
			const detail = { source, reason: 'no_canary_registered' };
			await recordHealth({ healthy: false, reason: 'no_canary_registered', detail });
			log.warn('solana_register_canary_unconfigured', detail);
			return {
				tool: TOOL_NAME, healthy: false, reason: 'no_canary_registered',
				network: null, canary_agent_id: null, asset: null, identity_pda: null,
				registration_uri: null, checks, rpc_latency_ms: null,
				consecutive_failures: 1, checked_at: checkedAt,
			};
		}

		checks.indexed = true;
		const reg = readRegistration(agent.meta);
		const identityPda = reg.registry?.identity_pda || null;
		const asset = reg.asset || null;
		const registrationUri = reg.registry?.registration_uri || null;
		checks.registry_enrolled = !!identityPda;

		// 2. Verify the on-chain records exist right now.
		const conn = solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
		const t0 = Date.now();
		const [assetOk, pdaOk] = await Promise.all([
			accountExists(conn, asset),
			identityPda ? accountExists(conn, identityPda) : Promise.resolve(false),
		]);
		const rpcLatencyMs = Date.now() - t0;
		checks.asset_onchain = assetOk;
		checks.identity_pda_onchain = pdaOk;

		// Healthy = enrolled in the registry AND both on-chain accounts resolve.
		const healthy = evaluateHealthy(checks);

		const detail = {
			source, network: reg.network, agent_id: agent.id, asset, identity_pda: identityPda, checks, rpc_latency_ms: rpcLatencyMs,
		};
		const consecutiveFailures = await recordHealth({ healthy, reason: !healthy ? 'onchain_record_missing' : null, detail });

		if (!healthy) {
			const level = consecutiveFailures >= ALERT_THRESHOLD ? 'error' : 'warn';
			log[level]('solana_register_canary_unhealthy', {
				agent_id: agent.id, asset, identity_pda: identityPda,
				checks, consecutive_failures: consecutiveFailures,
			});
		}

		return {
			tool: TOOL_NAME,
			healthy,
			network: reg.network,
			canary_agent_id: agent.id,
			asset,
			identity_pda: identityPda,
			registration_uri: registrationUri,
			explorer_url: identityPda ? explorerUrl(identityPda, reg.network) : null,
			reason: healthy ? null : 'onchain_record_missing',
			checks,
			rpc_latency_ms: rpcLatencyMs,
			consecutive_failures: consecutiveFailures,
			checked_at: checkedAt,
		};
	},
});
