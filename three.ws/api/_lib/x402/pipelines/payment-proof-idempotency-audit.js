// api/_lib/x402/pipelines/payment-proof-idempotency-audit.js
//
// Payment Proof Idempotency Audit — autonomous pipeline (self/idempotency).
//
// A run()-style registry entry (autonomous-registry.js → `payment-proof-idempotency-audit`)
// the per-tick spend loop invokes once a day. It is the platform's anti-fraud
// canary: it proves the x402 idempotency store actually prevents a replayed
// payment proof from settling twice.
//
// Why a run() pipeline and not a declarative entry: the audit makes ONE real
// $0.001 payment and then deliberately submits the SAME signed X-PAYMENT proof a
// second time, inspecting response headers across both calls. The declarative
// probe+pay path builds a fresh tx per call and can't replay an identical proof,
// so this needs to own its full sequence.
//
// On each run it:
//   1. Probes GET /api/x402/model-check (the cheapest idempotent, payment-
//      identifier-aware endpoint, $0.001) for the live 402 challenge.
//   2. Builds ONE real Solana USDC payment proof — signed with the platform seed
//      wallet via ../pay.js, never mocked — carrying a client payment-identifier
//      (the USE-15 idempotency extension) so the named store is exercised, not
//      just the always-on proof-hash fallback.
//   3. Fires the paid request once → expects 200 + on-chain settlement (tx_A).
//   4. Submits the IDENTICAL X-PAYMENT header again (retried briefly to let the
//      cross-replica idempotency cache write land). A correct store either
//      replays the cached 200 (`x-x402-idempotent: replay`) or rejects with a
//      409 conflict / in-flight — in every case carrying NO new on-chain
//      settlement. The audit fails only if the second call settles a NEW,
//      distinct tx (a real double-settlement).
//   5. Records the verdict to `x402_idempotency_audit` and raises an ops alert if
//      a double-settlement is ever observed.
//
// Recording: the loop records one x402_autonomous_log row per run (the returned
// signalData lands in signal_data, amountAtomic reflects ONLY the single first
// charge). The dedicated value sink is the `x402_idempotency_audit` table written
// here — one row per audit with the full two-call evidence and the pass/fail
// verdict.
//
// Downstream consumer: api/ops/health.js reads the latest `x402_idempotency_audit`
// row and folds a confirmed double-settlement into the platform health verdict
// (alongside the cross-network circuit breaker), so the status page / on-call
// surface a broken anti-replay guard immediately.

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	getMint,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	PAYMENT_IDENTIFIER,
	generatePaymentId,
} from '@x402/extensions/payment-identifier';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { sendOpsAlert } from '../../alerts.js';
import { solanaConnection } from '../../solana/connection.js';
import {
	loadSeedKeypair,
	parseSolanaAccept,
	buildPaymentTx,
	fetchWithTimeout,
	admitSponsorSettle,
	nextAutoNonce,
	currentBlockhash,
	USDC_MINT,
	SOLANA_RPC,
} from '../pay.js';

const log = logger('x402-idempotency-audit');

// The audit target: the cheapest endpoint that hand-rolls the x402 dance AND
// wires the USE-15 idempotency cache (checkCache → writeCachedResponse). $0.001,
// GET, deterministic. fox.glb is a tiny public canary the server fetches behind
// its SSRF guard; pinned to the canonical public origin (not the loop's runtime
// origin) so model-check always has a real public asset to inspect.
const AUDIT_ROUTE = '/api/x402/model-check';
const CANARY_GLB = 'https://three.ws/avatars/fox.glb';

// The second (replay) submission can land before the first call's storeResponse
// write has propagated across Upstash replicas. Retry the replay a few times,
// spaced out, breaking as soon as the idempotency store answers — this makes the
// cache-hit path deterministic without guessing a single magic delay. Each miss
// is harmless: an identical, already-settled Solana tx cannot re-settle on-chain,
// so a cache miss degrades to an on-chain-blocked settle, never a double charge.
const REPLAY_ATTEMPTS = 4;
const REPLAY_BACKOFF_MS = 600;

const usdcMint = () => USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pull the settled on-chain tx signature out of an X-PAYMENT-RESPONSE header.
function txFromResponse(headers) {
	const xpr = headers?.get?.('x-payment-response');
	if (!xpr) return null;
	try {
		const settled = JSON.parse(Buffer.from(xpr, 'base64').toString('utf8'));
		return settled?.transaction || null;
	} catch {
		// Header present but unparseable — settlement happened, signature unknown.
		return null;
	}
}

let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS x402_idempotency_audit (
			id                bigserial PRIMARY KEY,
			ts                timestamptz DEFAULT now(),
			run_id            uuid,
			route             text NOT NULL,
			payment_id        text,
			first_status      int,
			first_tx          text,
			first_settled     boolean NOT NULL DEFAULT false,
			second_status     int,
			second_tx         text,
			second_marker     text,
			replay_attempts   int,
			verdict           text NOT NULL,
			double_settled    boolean NOT NULL DEFAULT false,
			pass              boolean NOT NULL,
			amount_atomic     bigint NOT NULL DEFAULT 0,
			duration_ms       int,
			error_msg         text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_idempotency_audit_ts ON x402_idempotency_audit (ts DESC)`;
	_schemaReady = true;
}

async function storeAudit(sql, runId, row) {
	try {
		await ensureSchema(sql);
		await sql`
			INSERT INTO x402_idempotency_audit
				(run_id, route, payment_id, first_status, first_tx, first_settled,
				 second_status, second_tx, second_marker, replay_attempts, verdict,
				 double_settled, pass, amount_atomic, duration_ms, error_msg)
			VALUES
				(${runId || null}, ${row.route}, ${row.payment_id || null},
				 ${row.first_status}, ${row.first_tx || null}, ${row.first_settled},
				 ${row.second_status}, ${row.second_tx || null}, ${row.second_marker || null},
				 ${row.replay_attempts}, ${row.verdict}, ${row.double_settled}, ${row.pass},
				 ${row.amount_atomic || 0}, ${row.duration_ms}, ${row.error_msg || null})
		`;
	} catch (err) {
		// A DB fault must never crash the loop — log and move on.
		log.warn('idempotency_audit_insert_failed', { message: err?.message });
	}
}

/**
 * Run the payment-proof idempotency audit. Self-contained: builds its own Solana
 * payment context when one isn't supplied, so it can be invoked directly (manual
 * test / standalone) or handed the per-tick loop's shared blockhash + keypair.
 *
 * @param {object} [ctx] — supplied by the loop:
 *   { origin, buyer, conn, blockhash, mintInfo, redis, sql, log, runId, remainingCap }
 * @returns {Promise<{success:boolean, amountAtomic:number, txSig:string|null,
 *   responseData:object|null, signalData:object, errorMsg:string|null,
 *   skipped?:boolean, note?:string}>} the outcome the loop records to
 *   x402_autonomous_log.
 */
export async function runIdempotencyAudit(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const sql = ctx.sql || defaultSql;
	const remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;
	const endpointUrl = `${origin}${AUDIT_ROUTE}?url=${encodeURIComponent(CANARY_GLB)}`;
	// Replay cadence is tunable (ctx overrides) so the loop keeps its propagation-
	// tolerant defaults while tests can drive the sequence without real wait time.
	const replayAttempts = Number.isFinite(ctx.replayAttempts) ? ctx.replayAttempts : REPLAY_ATTEMPTS;
	const replayBackoffMs = Number.isFinite(ctx.replayBackoffMs) ? ctx.replayBackoffMs : REPLAY_BACKOFF_MS;
	const t0 = Date.now();

	const fail = (errorMsg, extra = {}) => ({
		success: false,
		amountAtomic: 0,
		txSig: null,
		responseData: null,
		signalData: { audited: false, route: AUDIT_ROUTE, error: errorMsg },
		errorMsg,
		...extra,
	});

	// ── Wallet pre-flight: exit gracefully (logged) if unconfigured ────────────
	let buyer = ctx.buyer;
	if (!buyer) {
		try {
			buyer = loadSeedKeypair();
		} catch (err) {
			log.info('idempotency_audit_skipped', { reason: err.message });
			return fail(`wallet_unconfigured: ${err.message}`, { skipped: true });
		}
	}

	// ── Solana payment context (reuse loop's, else build our own) ──────────────
	let conn = ctx.conn;
	let blockhash = ctx.blockhash;
	let mintInfo = ctx.mintInfo;
	if (!conn || !blockhash || !mintInfo) {
		try {
			conn = conn || solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
			const [bh, mi] = await Promise.all([
				blockhash ? Promise.resolve({ blockhash }) : conn.getLatestBlockhash('confirmed'),
				mintInfo ? Promise.resolve(mintInfo) : getMint(conn, new PublicKey(usdcMint())),
			]);
			blockhash = blockhash || bh.blockhash;
			mintInfo = mintInfo || mi;
		} catch (err) {
			log.warn('idempotency_audit_solana_preflight_failed', { message: err?.message });
			return fail(`solana_preflight_failed: ${err?.message}`, { skipped: true });
		}
	}

	// ── Step 1: probe for the 402 challenge ────────────────────────────────────
	let probe;
	try {
		probe = await fetchWithTimeout(endpointUrl, {
			method: 'GET',
			headers: { 'user-agent': 'threews-x402-autonomous/1.0' },
		});
	} catch (err) {
		return fail(`probe_failed: ${err?.message || 'network'}`);
	}
	if (probe.status !== 402) return fail(`unexpected_probe_status: ${probe.status}`);
	const accept = parseSolanaAccept(probe.body);
	if (!accept) return fail('no_solana_accept');
	if (accept.asset !== usdcMint()) return fail(`unexpected_asset: ${accept.asset}`);
	if (!accept.extra?.feePayer) return fail('missing_fee_payer');

	const amountAtomic = Number(accept.amount || 0);
	if (!(amountAtomic > 0)) return fail('zero_price');
	if (amountAtomic > remainingCap) return fail('cap_would_exceed', { skipped: true });
	// The loop hands every pipeline the tick's shared blockhash: a random nonce
	// keeps this payment's signature distinct from any other same-amount payment
	// to the same payTo in the tick (see x402-autonomous-loop.js).
	const payNonce = nextAutoNonce();
	const admission = await admitSponsorSettle({ accept, connection: conn, nonce: payNonce });
	if (!admission.ok) return fail(admission.reason || 'fee_runway_exhausted', { skipped: true });

	// ── Step 2: build ONE signed payment proof carrying a payment-identifier ───
	// The same base64 header is replayed verbatim in step 4 — that single proof
	// is the whole point of the audit. The payment-identifier (USE-15) keys the
	// named idempotency store; the raw-header hash is the always-on fallback. Both
	// must point a replay at the cached response, never a second settlement.
	const paymentId = generatePaymentId();
	let xPayment;
	try {
		const receiverAta = getAssociatedTokenAddressSync(
			new PublicKey(accept.asset), new PublicKey(accept.payTo),
			false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		);
		const receiverAtaInfo = await conn.getAccountInfo(receiverAta).catch(() => null);
		// Sign against a fresh blockhash: this runs inside a loop tick that can be
		// minutes old, and the tick's own hash expires after about 60 seconds.
		const signBlockhash = await currentBlockhash(conn, blockhash);
		const txBase64 = buildPaymentTx({
			accept, buyer, blockhash: signBlockhash, mintInfo, receiverAtaExists: receiverAtaInfo !== null,
			nonce: payNonce,
		});
		xPayment = Buffer.from(JSON.stringify({
			x402Version: 2,
			scheme: 'exact',
			network: accept.network,
			resource: { url: endpointUrl, mimeType: 'application/json' },
			payload: { transaction: txBase64 },
			accepted: accept,
			// USE-15 idempotency extension — server reads info.id as the cache key.
			extensions: { [PAYMENT_IDENTIFIER]: { info: { required: false, id: paymentId } } },
		})).toString('base64');
	} catch (err) {
		return fail(`build_payment_failed: ${err?.message || 'unknown'}`);
	}

	const paidHeaders = {
		'user-agent': 'threews-x402-autonomous/1.0',
		'x-payment': xPayment,
	};

	// ── Step 3: first paid submission → expect a real on-chain settlement ──────
	let first;
	try {
		first = await fetchWithTimeout(endpointUrl, { method: 'GET', headers: paidHeaders });
	} catch (err) {
		return fail(`first_call_failed: ${err?.message || 'network'}`);
	}
	const firstTx = first.ok ? txFromResponse(first.headers) : null;
	const firstSettled = !!(first.ok && firstTx);
	const firstMarker = first.headers?.get?.('x-x402-idempotent') || null;

	// The first call must actually settle for there to be anything to double-spend.
	// A 402 (payment rejected), a non-settling 200, or a first call that itself
	// replays an earlier proof leaves nothing to audit — record inconclusive, no
	// spend booked.
	if (!firstSettled) {
		const why = first.status === 402
			? 'first_call_402_rejected'
			: firstMarker
				? `first_call_replayed:${firstMarker}`
				: `first_call_not_settled:http_${first.status}`;
		const durationMs = Date.now() - t0;
		await storeAudit(sql, runId, {
			route: AUDIT_ROUTE, payment_id: paymentId,
			first_status: first.status, first_tx: firstTx, first_settled: false,
			second_status: null, second_tx: null, second_marker: null,
			replay_attempts: 0, verdict: 'inconclusive', double_settled: false,
			pass: false, amount_atomic: 0, duration_ms: durationMs, error_msg: why,
		});
		log.info('idempotency_audit_inconclusive', { run_id: runId, reason: why, status: first.status });
		return {
			success: false, amountAtomic: 0, txSig: firstTx,
			responseData: { first_status: first.status },
			signalData: { audited: false, route: AUDIT_ROUTE, verdict: 'inconclusive', reason: why },
			errorMsg: why, note: why,
		};
	}

	// ── Step 4: replay the IDENTICAL proof → must NOT settle a second time ─────
	let second = null;
	let secondTx = null;
	let secondMarker = null;
	let doubleSettled = false;
	let attempts = 0;
	for (let i = 0; i < replayAttempts; i++) {
		attempts = i + 1;
		// Let the first call's cross-replica cache write land before each attempt.
		await sleep(replayBackoffMs);
		try {
			second = await fetchWithTimeout(endpointUrl, { method: 'GET', headers: paidHeaders });
		} catch (err) {
			second = { ok: false, status: 0, headers: null, body: { error: err?.message || 'network' } };
			continue;
		}
		secondMarker = second.headers?.get?.('x-x402-idempotent') || null;
		secondTx = second.ok ? txFromResponse(second.headers) : null;
		// A distinct, freshly-settled tx on the replay is the one failure mode that
		// matters: the anti-replay guard let the same proof settle twice.
		if (secondTx && secondTx !== firstTx) {
			doubleSettled = true;
			break;
		}
		// The idempotency store answered (replay / conflict / in-flight) → done.
		if (secondMarker) break;
		// No marker and no new settlement: a cache miss that the on-chain layer
		// blocked (already-processed tx). Retry to give the store time to populate.
	}

	const durationMs = Date.now() - t0;

	// ── Step 5: classify the verdict ───────────────────────────────────────────
	// pass = the second submission produced NO new on-chain settlement. The store
	// proves it via a replay/conflict/in-flight marker; absent a marker, the audit
	// still passes only because no distinct tx settled (on-chain backstop), but
	// that path is flagged so a silently-degraded cache store is visible.
	let verdict;
	if (doubleSettled) {
		verdict = 'double_settled';
	} else if (secondMarker === 'replay') {
		verdict = 'idempotent_replay';
	} else if (secondMarker === 'conflict') {
		verdict = 'idempotent_conflict';
	} else if (secondMarker === 'in-flight') {
		verdict = 'idempotent_inflight';
	} else if (second && !second.ok && !secondTx) {
		// Second submission failed to settle (e.g. on-chain rejected the duplicate
		// tx) without the store ever answering — no double-spend, but the store
		// didn't demonstrably catch it.
		verdict = 'settle_blocked_no_marker';
	} else {
		verdict = 'no_double_settle_no_marker';
	}
	const pass = !doubleSettled;
	const errorMsg = doubleSettled
		? `double_settlement: first=${firstTx} second=${secondTx}`
		: verdict.endsWith('no_marker')
			? `replay_unconfirmed:${verdict}`
			: null;

	const signalData = {
		audited: true,
		route: AUDIT_ROUTE,
		verdict,
		pass,
		double_settled: doubleSettled,
		payment_id: paymentId,
		first_tx: firstTx,
		second_marker: secondMarker,
		second_status: second?.status ?? null,
		replay_attempts: attempts,
	};

	await storeAudit(sql, runId, {
		route: AUDIT_ROUTE, payment_id: paymentId,
		first_status: first.status, first_tx: firstTx, first_settled: true,
		second_status: second?.status ?? null, second_tx: secondTx, second_marker: secondMarker,
		replay_attempts: attempts, verdict, double_settled: doubleSettled,
		pass, amount_atomic: amountAtomic, duration_ms: durationMs, error_msg: errorMsg,
	});

	if (doubleSettled) {
		// Fire-and-forget: a confirmed double-settlement is a fraud-critical event.
		sendOpsAlert(
			'x402 idempotency store FAILED — double settlement',
			`${AUDIT_ROUTE}: the same payment proof settled twice — ` +
				`first tx ${firstTx}, second tx ${secondTx} (payment-id ${paymentId}). ` +
				'The anti-replay guard is not protecting paid endpoints.',
			{ signature: 'x402-idempotency:double-settle' },
		).catch(() => {});
	}

	log.info('idempotency_audit_complete', {
		run_id: runId, verdict, pass, double_settled: doubleSettled,
		first_tx: firstTx, second_marker: secondMarker, attempts, duration_ms: durationMs,
	});

	// amountAtomic reflects ONLY the single legitimate first charge — a correct
	// audit moves USDC exactly once. txSig is that first settlement.
	return {
		success: pass,
		amountAtomic,
		txSig: firstTx,
		responseData: {
			first: { status: first.status, tx: firstTx },
			second: { status: second?.status ?? null, tx: secondTx, marker: secondMarker },
		},
		signalData,
		errorMsg,
		note: verdict,
	};
}

// Alias matching the pipelines convention (bazaar-warmup exports `run`).
export { runIdempotencyAudit as run };
