// api/_lib/x402/pipelines/pay-by-name-resolver.js
//
// Pay-By-Name Resolution Health — autonomous pipeline (health).
//
// The pay-by-name registry is the entry point for every "send USDC to a name"
// flow on three.ws: the SDK's payByName(), the /pay studio, the profile
// pay-button, and any agent that wants to route a payment to `@handle`,
// `<label>.threews.sol`, or a raw address all resolve the recipient through
// GET /api/x402/pay-by-name?name=<name> before a single lamport moves. If that
// resolver breaks — Bonfida SNS regresses, the parent domain de-registers, the
// DB claim join changes, or (worst case) the platform domain silently repoints
// to a wallet that isn't ours — every downstream send is paid to the wrong
// place or fails outright. This monitor is the canary in front of that path.
//
// Every 10 minutes it resolves a KNOWN name (the platform's own SNS parent
// domain, `<PARENT_LABEL>.sol`, derived from threews-sns.js so it always tracks
// config) and asserts the registry returns a valid, on-curve Solana address. If
// X402_PAY_BY_NAME_EXPECTED_ADDRESS is set, it additionally requires the
// resolution to MATCH that wallet — an anti-poisoning check that catches a
// domain repoint between deploys before a user is told to pay it.
//
// Endpoint: GET /api/x402/pay-by-name?name=<name> — a FREE resolve-only read
// (no 402, no payment; the resolve path is intentionally free so the SDK and
// browser can preview a recipient). Because the call is free this pipeline
// moves no funds — amountAtomic is always 0. The autonomous loop probes the
// endpoint first; a non-402, non-OK response is a real resolver failure (not a
// "free success"), so run() owns the OK/verified classification rather than the
// generic loop path, which would otherwise record a 404 as healthy.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js
// (`pay-by-name-resolution`). The per-tick loop (api/cron/x402-autonomous-loop.js)
// hands run() { origin, redis, sql, log, runId } and records the returned
// outcome as one row in x402_autonomous_log (pipeline 'health'). Called
// standalone (manual test) it derives its own origin/sql and still works.
//
// Value extracted & where it lands:
//   • pay_by_name_resolution_log — one time-series row per run. Columns:
//       name             → the name resolved this run
//       address          → the on-chain address it resolved to (null on failure)
//       source           → resolver namespace ('sns' | 'username' | 'address')
//       verified         → resolved to a valid on-curve address (and matched the
//                          expected wallet, when one is configured)
//       valid_address    → address parses as an on-curve Solana pubkey
//       address_mismatch → resolved address ≠ expected wallet (poisoning flag)
//       expected_address → the wallet we asserted against (null if unset)
//       error_msg        → why a run was not verified
//   • Redis x402:pay-by-name:latest — newest verdict for cheap dashboard reads.
//   • Redis x402:pay-by-name:alert  — present (with TTL) only while resolution is
//     failing or poisoned, so a consumer can detect the alert state in one GET.

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

import { fetchWithTimeout } from '../pay.js';
import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { PARENT_LABEL } from '../../threews-sns.js';

const log = logger('x402-pay-by-name-resolver');

// The known name to resolve each run. Defaults to the platform's own SNS parent
// domain (e.g. 'threews.sol'), derived from PARENT_LABEL so it always tracks the
// configured parent. Override via env to canary a different known name.
export const PROBE_NAME = (
	process.env.X402_PAY_BY_NAME_PROBE_NAME ||
	env.X402_PAY_BY_NAME_PROBE_NAME ||
	`${PARENT_LABEL}.sol`
).trim();

// Optional anti-poisoning assertion: when set, the resolution must match this
// exact wallet to count as verified. Catches the platform domain repointing to a
// wallet that isn't ours between deploys. Unset → any valid on-curve address
// resolved from the name counts as verified.
export const EXPECTED_ADDRESS = (
	(process.env.X402_PAY_BY_NAME_EXPECTED_ADDRESS ||
		env.X402_PAY_BY_NAME_EXPECTED_ADDRESS ||
		'').trim()
) || null;

const REDIS_LATEST_KEY = 'x402:pay-by-name:latest';
const REDIS_ALERT_KEY = 'x402:pay-by-name:alert';
// Alert key TTL: a little over two monitor cycles (10 min) so a missed run lets
// the flag lapse to "unknown" rather than latching a stale alert forever.
const ALERT_TTL_SECONDS = 25 * 60;

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// A recipient is a real wallet only if the address parses AND lies on the ed25519
// curve. Off-curve addresses (PDAs / program addresses) can't custody a token
// account the way a user wallet does, so an off-curve "recipient" is never valid.
function isValidWallet(addr) {
	if (typeof addr !== 'string' || !ADDR_RE.test(addr)) return false;
	try {
		return PublicKey.isOnCurve(new PublicKey(addr).toBytes());
	} catch {
		return false;
	}
}

/**
 * Derive the resolution verdict from a GET /api/x402/pay-by-name?name= response.
 * Pure + side-effect-free so it can be unit-tested against a real payload and
 * reused by both the time-series sink and the autonomous-log signal_data.
 *
 * @param {object|null} body — the parsed response body ({ data: { address,
 *   source, resolved } }) or null when the resolve call failed / returned non-OK.
 * @param {{ name?: string, expectedAddress?: string|null }} opts
 * @returns {{ name, address, source, resolved, valid_address, expected_address,
 *   address_mismatch, verified }}
 */
export function classifyResolution(body, { name = null, expectedAddress = null } = {}) {
	const data = (body && body.data) || null;
	const address = (data && data.address) || null;
	const source = (data && data.source) || null;
	const resolvedName = (data && data.resolved) || null;

	const validAddress = isValidWallet(address);
	let addressMismatch = false;
	let verified = validAddress;
	if (verified && expectedAddress) {
		addressMismatch = address !== expectedAddress;
		if (addressMismatch) verified = false;
	}

	return {
		name: name || resolvedName || null,
		address,
		source,
		resolved: resolvedName,
		valid_address: validAddress,
		expected_address: expectedAddress || null,
		address_mismatch: addressMismatch,
		verified,
	};
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS pay_by_name_resolution_log (
			id               bigserial PRIMARY KEY,
			ts               timestamptz NOT NULL DEFAULT now(),
			run_id           uuid,
			name             text,
			address          text,
			source           text,
			verified         boolean NOT NULL DEFAULT false,
			valid_address    boolean NOT NULL DEFAULT false,
			address_mismatch boolean NOT NULL DEFAULT false,
			expected_address text,
			error_msg        text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS pay_by_name_resolution_log_ts ON pay_by_name_resolution_log (ts DESC)`;
	_schemaReady = true;
}

async function persistSample(sql, runId, verdict, errorMsg) {
	try {
		await sql`
			INSERT INTO pay_by_name_resolution_log
				(ts, run_id, name, address, source, verified,
				 valid_address, address_mismatch, expected_address, error_msg)
			VALUES
				(now(), ${runId}, ${verdict.name}, ${verdict.address}, ${verdict.source},
				 ${verdict.verified}, ${verdict.valid_address}, ${verdict.address_mismatch},
				 ${verdict.expected_address}, ${errorMsg || null})
		`;
	} catch (err) {
		// DB failure on the sink is logged but must never crash the loop.
		log.warn('pay_by_name_insert_failed', { message: err?.message });
	}
}

async function writeRedisState(redis, verdict, errorMsg) {
	if (!redis) return;
	const sample = {
		ts: new Date().toISOString(),
		name: verdict.name,
		address: verdict.address,
		source: verdict.source,
		verified: verdict.verified,
		address_mismatch: verdict.address_mismatch,
		expected_address: verdict.expected_address,
		error_msg: errorMsg || null,
	};
	try {
		await redis.set(REDIS_LATEST_KEY, JSON.stringify(sample), { ex: ALERT_TTL_SECONDS });
		if (!verdict.verified) {
			await redis.set(REDIS_ALERT_KEY, JSON.stringify(sample), { ex: ALERT_TTL_SECONDS });
		} else {
			// Cleared — resolution is healthy again, drop any lingering alert flag.
			await redis.del(REDIS_ALERT_KEY);
		}
	} catch (err) {
		log.warn('pay_by_name_redis_write_failed', { message: err?.message });
	}
}

/**
 * Run the pay-by-name resolution health check. Conforms to the run()-style
 * registry contract.
 *
 * @param {object} ctx — supplied by the autonomous loop:
 *   { origin, redis, sql, log, runId }. All optional for standalone/manual runs.
 * @returns the aggregate outcome the loop records to x402_autonomous_log:
 *   { success, amountAtomic, txSig, responseData, signalData, errorMsg, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const sql = ctx.sql || defaultSql;
	const redis = ctx.redis || null;
	const name = PROBE_NAME;
	const endpointUrl = `${origin}/api/x402/pay-by-name?name=${encodeURIComponent(name)}`;

	// Schema first: without the sink there's no time-series to write.
	try {
		await ensureSchema(sql);
	} catch (err) {
		log.warn('pay_by_name_schema_failed', { message: err?.message });
		return { success: false, amountAtomic: 0, txSig: null, skipped: true, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Resolve the known name (free GET — no 402, no payment) ────────────────
	let res;
	try {
		res = await fetchWithTimeout(endpointUrl, {
			method: 'GET',
			headers: { 'user-agent': 'threews-x402-pay-by-name/1.0' },
		});
	} catch (err) {
		// Network failure / timeout — never crash the loop.
		const errorMsg = `resolve_fetch_failed: ${err?.message || 'network'}`;
		log.warn('pay_by_name_fetch_failed', { message: err?.message });
		const verdict = classifyResolution(null, { name, expectedAddress: EXPECTED_ADDRESS });
		await persistSample(sql, runId, verdict, errorMsg);
		await writeRedisState(redis, verdict, errorMsg);
		return { success: false, amountAtomic: 0, txSig: null, signalData: verdict, errorMsg, note: 'fetch_failed' };
	}

	// Non-OK on a free endpoint is a REAL resolver failure (e.g. 404 — the known
	// name no longer resolves), not a free success. Record it as unhealthy.
	if (!res.ok) {
		const errorMsg = `resolve_http_${res.status}`;
		log.warn('pay_by_name_resolve_non_ok', { status: res.status, name });
		const verdict = classifyResolution(null, { name, expectedAddress: EXPECTED_ADDRESS });
		await persistSample(sql, runId, verdict, errorMsg);
		await writeRedisState(redis, verdict, errorMsg);
		return {
			success: false, amountAtomic: 0, txSig: null,
			responseData: { status: res.status, name }, signalData: verdict,
			errorMsg, note: errorMsg,
		};
	}

	const verdict = classifyResolution(res.body, { name, expectedAddress: EXPECTED_ADDRESS });
	const errorMsg = verdict.verified
		? null
		: verdict.address_mismatch
			? 'address_mismatch'
			: verdict.address
				? 'invalid_address'
				: 'unresolved';

	await persistSample(sql, runId, verdict, errorMsg);
	await writeRedisState(redis, verdict, errorMsg);

	if (!verdict.verified) {
		log.warn('pay_by_name_unverified', {
			run_id: runId, name, address: verdict.address,
			expected: verdict.expected_address, mismatch: verdict.address_mismatch, error: errorMsg,
		});
	} else {
		log.info('pay_by_name_verified', { run_id: runId, name, address: verdict.address, source: verdict.source });
	}

	return {
		// success = the known name resolved to a valid (and, when configured,
		// expected) on-chain wallet — i.e. the pay-by-name registry is functioning.
		success: verdict.verified,
		amountAtomic: 0,
		txSig: null,
		responseData: { name: verdict.name, address: verdict.address, source: verdict.source },
		signalData: verdict,
		errorMsg,
		note: verdict.verified
			? `${name} → ${verdict.address}`
			: verdict.address_mismatch
				? `ADDRESS_MISMATCH ${verdict.address} ≠ ${verdict.expected_address}`
				: errorMsg,
	};
}

export const PAY_BY_NAME_RESOLUTION = Object.freeze({
	endpoint: '/api/x402/pay-by-name',
	probeName: PROBE_NAME,
	expectedAddress: EXPECTED_ADDRESS,
	redisLatestKey: REDIS_LATEST_KEY,
	redisAlertKey: REDIS_ALERT_KEY,
});
