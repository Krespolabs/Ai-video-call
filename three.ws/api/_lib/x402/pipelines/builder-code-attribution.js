// api/_lib/x402/pipelines/builder-code-attribution.js
//
// Builder Code Attribution Tracker — autonomous pipeline (self / Finance).
//
// Coinbase builder rewards (and x402scan analytics) credit on-chain x402
// volume to the app that exposed the paid endpoint via the ERC-8021 Schema 2
// `builder-code` extension. For three.ws that app code is
// `three_d_agent` (env X402_BUILDER_CODE_APP). The credit only happens when:
//
//   1. the paid endpoint DECLARES the builder-code extension on its 402
//      challenge (extensions["builder-code"].info.a = "three_d_agent"), AND
//   2. the buyer ECHOES that app code in its X-PAYMENT payload, so the
//      facilitator suffixes the settlement-tx calldata with the attribution
//      CBOR map at settle time.
//
// If a single priced endpoint silently drops the declaration (a route that
// bypasses build402Body, an env regression that unsets X402_BUILDER_CODE_APP,
// or a deploy that forgets the extension), every USDC dollar that endpoint
// settles is UNATTRIBUTED — real revenue that earns three.ws zero builder
// rewards. Nothing surfaces that gap today.
//
// This tracker is the watchdog. Every 6h the autonomous loop calls run(ctx):
//
//   • ATTRIBUTION SWEEP (free) — probes a representative set of priced
//     /api/x402/* endpoints for their live 402 challenge and verifies each one
//     declares the builder-code extension with a === three_d_agent. Any 402
//     endpoint missing/mismatched is an attribution gap → alert.
//
//   • SETTLEMENT PROOF (one real $0.001 payment) — pays the cheapest declaring
//     endpoint (dance-tip) with the builder-code echo ATTACHED to the X-PAYMENT
//     envelope (a=three_d_agent, w=<wallet code>, s=[builder_code_attribution]),
//     then reads the X-PAYMENT-RESPONSE header. The resource server enforces the
//     echo (it rejects a non-echoing payment with `builder_code_tampered`, 402),
//     so a 200 + settled tx signature is end-to-end proof that an ATTRIBUTED
//     payment settles on-chain — the tx Coinbase's reward indexer reads. The
//     header's settlement object (transaction/network/payer, plus any
//     extensions the route echoes back) is captured for audit.
//
// Value sink: builder_code_attribution (one upserted row per endpoint, keyed by
//   endpoint). Columns carry the per-endpoint declaration verdict + the live
//   settlement proof. See ensureSchema() below for the full shape.
//
// Downstream consumer: api/ops/health.js → loadBuilderAttribution() folds an
//   attribution gap (a priced endpoint that stopped declaring three_d_agent, or
//   a failed attributed settlement) into the platform health verdict so on-call
//   sees lost-rewards risk before a billing cycle closes.
//
// The loop owns cooldown, daily-spend accounting and the single summary row in
// x402_autonomous_log (value_extracted = the attribution summary). This module
// owns the probes, the attributed payment, the per-endpoint persistence and the
// gap detection. No mocks — every probe reads a live challenge and the proof is
// a real on-chain USDC payment.

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { BUILDER_CODE, isValidBuilderCode } from '../../x402-builder-code.js';
import {
	fetchWithTimeout,
	parseSolanaAccept,
	buildPaymentTx,
	bootstrapSolanaContext,
	admitSponsorSettle,
	nextAutoNonce,
	currentBlockhash,
	USDC_MINT,
} from '../pay.js';

const log = logger('x402-builder-code-attribution');

const USER_AGENT = 'threews-x402-builder-attribution/1.0';

// The service code this tracker self-attributes with on its settlement echo.
const SERVICE_CODE = 'builder_code_attribution';

// Redis flag a consumer can read in one GET to learn an attribution gap is open.
const REDIS_ALERT_KEY = 'x402:builder-attribution:alert';
const ALERT_TTL_SECONDS = 7 * 60 * 60; // a little over the 6h cadence

// Representative set of priced /api/x402/* endpoints. Every one of these flows
// through paidEndpoint → build402Body, which auto-declares the builder-code
// extension when X402_BUILDER_CODE_APP is set — so each is expected to advertise
// `a = three_d_agent` on its 402 challenge. `settle: true` marks the single
// endpoint we actually pay (the cheapest, $0.001 dance-tip) to prove the
// attributed settlement path end-to-end; the rest are probe-only (free).
const SWEEP_ENDPOINTS = [
	{
		// dance-tip is GET (query params); booking one $0.001 dance is the same
		// benign side effect the volume entries already produce, so it's our paid
		// settlement proof. The probe (free 402) books nothing; the ticket is
		// created only after payment settles.
		path: '/api/x402/dance-tip?dancer=4&dance=hiphop',
		method: 'GET',
		body: null,
		settle: true,
	},
	{
		// model-check keys on a query param; a stable public rig keeps the probe
		// deterministic. The probe never pays, so it books nothing.
		path: `/api/x402/model-check?url=${encodeURIComponent('https://three.ws/avatars/xbot.glb')}`,
		method: 'GET',
		body: null,
	},
	{ path: '/api/x402/crypto-intel', method: 'POST', body: { topic: 'solana' } },
	{
		// token-intel is GET (?mint=…). Canary: the well-known USDC mint.
		path: '/api/x402/token-intel?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&network=mainnet',
		method: 'GET',
		body: null,
	},
	{ path: '/api/x402/fact-check', method: 'POST', body: { claim: 'The sky is blue' } },
	{
		// symbol-availability is GET (?ticker=…&network=…).
		path: '/api/x402/symbol-availability?ticker=HEALTH&network=mainnet',
		method: 'GET',
		body: null,
	},
];

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS builder_code_attribution (
			endpoint             text PRIMARY KEY,
			method               text,
			challenged           boolean NOT NULL DEFAULT false, -- returned a real 402
			attributed           boolean NOT NULL DEFAULT false, -- declared builder-code on the challenge
			declared_code        text,                           -- the app code (a) advertised
			expected_code        text,                           -- X402_BUILDER_CODE_APP in force
			matches              boolean NOT NULL DEFAULT false,  -- declared_code === expected_code
			price_atomic         bigint,                          -- challenge amount (atomics)
			gap                  boolean NOT NULL DEFAULT false,  -- 402 endpoint with missing/mismatched attribution
			settled              boolean NOT NULL DEFAULT false,  -- this endpoint carried the live settlement proof
			echo_accepted        boolean NOT NULL DEFAULT false,  -- attributed payment settled (server enforces echo)
			response_attributed  boolean NOT NULL DEFAULT false,  -- X-PAYMENT-RESPONSE echoed a builder-code block
			tx_signature         text,
			payer                text,
			error                text,
			run_id               uuid,
			checked_at           timestamptz DEFAULT now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS builder_code_attribution_gap_idx ON builder_code_attribution (gap) WHERE gap = true`;
	_schemaReady = true;
}

async function upsertRow(sql, runId, row) {
	await sql`
		INSERT INTO builder_code_attribution
			(endpoint, method, challenged, attributed, declared_code, expected_code,
			 matches, price_atomic, gap, settled, echo_accepted, response_attributed,
			 tx_signature, payer, error, run_id, checked_at)
		VALUES
			(${row.endpoint}, ${row.method}, ${row.challenged}, ${row.attributed},
			 ${row.declared_code || null}, ${row.expected_code || null},
			 ${row.matches}, ${row.price_atomic ?? null}, ${row.gap}, ${row.settled},
			 ${row.echo_accepted}, ${row.response_attributed},
			 ${row.tx_signature || null}, ${row.payer || null}, ${row.error || null},
			 ${runId}, now())
		ON CONFLICT (endpoint) DO UPDATE SET
			method              = EXCLUDED.method,
			challenged          = EXCLUDED.challenged,
			attributed          = EXCLUDED.attributed,
			declared_code       = EXCLUDED.declared_code,
			expected_code       = EXCLUDED.expected_code,
			matches             = EXCLUDED.matches,
			price_atomic        = EXCLUDED.price_atomic,
			gap                 = EXCLUDED.gap,
			settled             = EXCLUDED.settled,
			echo_accepted       = EXCLUDED.echo_accepted,
			response_attributed = EXCLUDED.response_attributed,
			tx_signature        = EXCLUDED.tx_signature,
			payer               = EXCLUDED.payer,
			error               = EXCLUDED.error,
			run_id              = EXCLUDED.run_id,
			checked_at          = now()
	`;
}

async function persistRows(sql, log, runId, rows) {
	try {
		await ensureSchema(sql);
		for (const row of rows) await upsertRow(sql, runId, row);
	} catch (err) {
		log?.warn?.('builder_attribution_persist_failed', { message: err?.message });
	}
}

// Pull the declared app builder code off a live 402 challenge body.
function declaredAppCode(challenge) {
	const a = challenge?.extensions?.[BUILDER_CODE]?.info?.a;
	return typeof a === 'string' ? a : null;
}

// Probe one endpoint for its 402 challenge and classify the attribution verdict.
// Free read — never pays. A non-402 response means the endpoint isn't priced
// (no rewards to attribute), recorded as not-a-gap.
async function probeEndpoint(origin, expectedCode, ep) {
	const endpointUrl = `${origin}${ep.path}`;
	const base = {
		endpoint: ep.path,
		method: ep.method,
		challenged: false,
		attributed: false,
		declared_code: null,
		expected_code: expectedCode,
		matches: false,
		price_atomic: null,
		gap: false,
		settled: false,
		echo_accepted: false,
		response_attributed: false,
		tx_signature: null,
		payer: null,
		error: null,
		_settle: !!ep.settle,
		_endpointUrl: endpointUrl,
		_body: ep.body,
	};
	try {
		const res = await fetchWithTimeout(endpointUrl, {
			method: ep.method,
			headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
			...(ep.body != null ? { body: JSON.stringify(ep.body) } : {}),
		});
		if (res.status !== 402) {
			// Not a priced challenge this call — nothing to attribute, not a gap.
			base.error = `not_402:http_${res.status}`;
			return base;
		}
		base.challenged = true;
		base.challenge = res.body;
		const accept = parseSolanaAccept(res.body);
		if (accept?.amount != null) base.price_atomic = Number(accept.amount);
		base.accept = accept;
		const code = declaredAppCode(res.body);
		base.declared_code = code;
		base.attributed = !!code;
		base.matches = !!code && code === expectedCode;
		// A priced (402) endpoint that fails to declare the expected app code can
		// never be credited — that is the attribution gap we alert on.
		base.gap = !base.matches;
		if (!base.attributed) base.error = 'builder_code_not_declared';
		else if (!base.matches) base.error = `builder_code_mismatch:${code}`;
		return base;
	} catch (err) {
		base.error = `probe_failed:${err?.message || 'network'}`;
		return base;
	}
}

// Settle ONE real attributed payment against the dance-tip challenge captured in
// the probe. Builds the SPL transfer, attaches the builder-code echo to the
// X-PAYMENT envelope, replays the request, and reads the X-PAYMENT-RESPONSE
// settlement. Returns the settlement outcome — never throws for protocol faults.
async function settleAttributed({ row, buyer, conn, blockhash, mintInfo, remainingCap, expectedCode }) {
	const accept = row.accept;
	const out = { amountAtomic: 0, txSig: null, payer: null, echoAccepted: false, responseAttributed: false, settleResp: null, error: null };

	if (!accept) { out.error = 'no_solana_accept'; return out; }
	if (!USDC_MINT || accept.asset !== USDC_MINT) { out.error = `unexpected_asset:${accept.asset}`; return out; }
	if (!accept.extra?.feePayer) { out.error = 'missing_fee_payer'; return out; }

	const amountAtomic = Number(accept.amount || 0);
	if (amountAtomic > (remainingCap ?? Infinity)) { out.error = 'cap_would_exceed'; return out; }
	// The loop hands every pipeline the tick's shared blockhash: a random nonce
	// keeps this payment's signature distinct from any other same-amount payment
	// to the same payTo in the tick (see x402-autonomous-loop.js).
	const payNonce = nextAutoNonce();
	const admission = await admitSponsorSettle({ accept, connection: conn, nonce: payNonce });
	if (!admission.ok) { out.error = admission.reason || 'fee_runway_exhausted'; return out; }

	// Echo the declared app code (anti-tamper: the server rejects a mismatch) and
	// self-attribute the wallet + service so the settlement CBOR records who
	// exposed the endpoint (a), who paid (w), and which service ran (s).
	const declaredA = declaredAppCode(row.challenge) || expectedCode;
	const echo = { a: declaredA };
	const walletCode = env.X402_BUILDER_CODE_WALLET;
	if (isValidBuilderCode(walletCode)) echo.w = walletCode;
	echo.s = [SERVICE_CODE];

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
			accept, buyer, blockhash: signBlockhash, mintInfo,
			receiverAtaExists: receiverAtaInfo !== null,
			nonce: payNonce,
		});
		const xPayment = Buffer.from(JSON.stringify({
			x402Version: 2,
			scheme: 'exact',
			network: accept.network,
			resource: { url: row._endpointUrl, mimeType: 'application/json' },
			payload: { transaction: txBase64 },
			accepted: accept,
			extensions: { [BUILDER_CODE]: echo },
		})).toString('base64');

		const paidRes = await fetchWithTimeout(row._endpointUrl, {
			method: row.method,
			headers: {
				'content-type': 'application/json',
				'user-agent': USER_AGENT,
				'x-payment': xPayment,
			},
			...(row._body != null ? { body: JSON.stringify(row._body) } : {}),
		});

		if (!paidRes.ok) {
			// A 402 here with builder_code_tampered would mean the echo was rejected —
			// captured verbatim so the verdict reflects exactly why attribution failed.
			const reason = paidRes.body?.error || paidRes.body?.code || `http_${paidRes.status}`;
			out.error = typeof reason === 'string' ? reason : `http_${paidRes.status}`;
			return out;
		}

		// 200 + accepted echo = the attributed payment settled. Read the receipt.
		out.echoAccepted = true;
		out.amountAtomic = amountAtomic;
		const header = paidRes.headers?.get?.('x-payment-response');
		if (header) {
			try {
				const settled = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
				out.settleResp = settled;
				out.txSig = settled?.transaction || null;
				out.payer = settled?.payer || null;
				out.responseAttributed = !!settled?.extensions?.[BUILDER_CODE];
			} catch { /* header malformed — settlement still happened */ }
		}
		return out;
	} catch (err) {
		out.error = `settle_threw:${err?.message || 'unknown'}`;
		return out;
	}
}

/**
 * Builder Code Attribution Tracker executor (run()-style registry contract).
 *
 * @param {object} ctx — supplied by the autonomous loop:
 *   { origin, buyer, conn, blockhash, mintInfo, remainingCap, redis, sql, log, runId }.
 *   All optional for standalone/manual runs (Solana context is bootstrapped on demand).
 * @returns the aggregate outcome the loop records to x402_autonomous_log:
 *   { success, amountAtomic, txSig, responseData, signalData, valueExtracted, errorMsg, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const sql = ctx.sql || defaultSql;
	const redis = ctx.redis || null;
	const expectedCode = env.X402_BUILDER_CODE_APP || null;

	// Attribution is disabled platform-wide when no app code is configured — there
	// is nothing to track and no rewards to earn. Record the state, spend nothing.
	if (!expectedCode) {
		log.info('builder_attribution_disabled', { run_id: runId });
		return {
			success: false,
			amountAtomic: 0,
			txSig: null,
			skipped: true,
			signalData: { enabled: false },
			errorMsg: 'builder_code_app_unset',
			note: 'X402_BUILDER_CODE_APP unset — attribution disabled',
		};
	}

	// ── Phase 1: attribution sweep (free probes) ──────────────────────────────
	const rows = await Promise.all(SWEEP_ENDPOINTS.map((ep) => probeEndpoint(origin, expectedCode, ep)));

	// ── Phase 2: settlement proof (one real attributed payment) ───────────────
	// Pay the cheapest declaring endpoint to prove an attributed settlement lands
	// on-chain. Skip the payment if that endpoint never declared attribution (the
	// gap is already recorded) or the wallet isn't configured.
	const settleRow = rows.find((r) => r._settle && r.challenged && r.matches);
	let amountAtomic = 0;
	let txSig = null;
	let settleResp = null;
	// settleExecuted = we actually had a wallet and ran the attributed payment.
	// Distinguishes "couldn't run the proof (no wallet)" from "proof failed".
	let settleExecuted = false;

	if (settleRow) {
		let solana = null;
		if (ctx.buyer && ctx.conn && ctx.blockhash && ctx.mintInfo) {
			solana = { buyer: ctx.buyer, conn: ctx.conn, blockhash: ctx.blockhash, mintInfo: ctx.mintInfo };
		} else {
			// Standalone/manual run — bootstrap our own Solana context. A missing
			// keypair degrades gracefully (recorded, no spend).
			try {
				solana = await bootstrapSolanaContext({ buyer: ctx.buyer });
			} catch (err) {
				settleRow.error = `wallet_unconfigured:${err?.message || 'no_keypair'}`;
			}
		}

		if (solana) {
			settleExecuted = true;
			const r = await settleAttributed({
				row: settleRow,
				buyer: solana.buyer,
				conn: solana.conn,
				blockhash: solana.blockhash,
				mintInfo: solana.mintInfo,
				remainingCap: ctx.remainingCap,
				expectedCode,
			});
			settleRow.settled = r.echoAccepted;
			settleRow.echo_accepted = r.echoAccepted;
			settleRow.response_attributed = r.responseAttributed;
			settleRow.tx_signature = r.txSig;
			settleRow.payer = r.payer;
			if (r.error) settleRow.error = r.error;
			amountAtomic = r.amountAtomic;
			txSig = r.txSig;
			settleResp = r.settleResp;
		}
	}

	// ── Persist per-endpoint verdicts (the value sink) ────────────────────────
	await persistRows(sql, log, runId, rows.map(stripScratch));

	// ── Derive the summary + alert state ──────────────────────────────────────
	const challenged = rows.filter((r) => r.challenged);
	const gaps = challenged.filter((r) => r.gap);
	const attributionOk = gaps.length === 0;
	// The settlement proof is meaningful only when we actually ran it (had a
	// declaring endpoint AND a wallet). A run that couldn't even attempt the proof
	// (no wallet, no declaring endpoint to pay) isn't a failure — only an executed
	// proof that came back echo_accepted=false is an attributed-settle FAILURE.
	const settleAttempted = !!settleRow;
	const settleProven = !!(settleRow && settleRow.echo_accepted);
	const proofOk = !settleExecuted || settleProven;

	await writeAlert(redis, attributionOk && proofOk ? null : {
		run_id: runId,
		gaps: gaps.map((g) => ({ endpoint: g.endpoint, error: g.error })),
		settle_proven: settleProven,
		ts: new Date().toISOString(),
	});

	const signalData = {
		expected_code: expectedCode,
		endpoints_probed: rows.length,
		endpoints_challenged: challenged.length,
		attributed: challenged.filter((r) => r.matches).length,
		gaps: gaps.length,
		gap_endpoints: gaps.map((g) => g.endpoint),
		attribution_ok: attributionOk,
		settle_attempted: settleAttempted,
		settle_proven: settleProven,
		settle_tx: txSig,
		response_attributed: !!(settleRow && settleRow.response_attributed),
	};

	if (!attributionOk) {
		log.warn('builder_attribution_gap', { run_id: runId, gaps: signalData.gap_endpoints, expected: expectedCode });
	} else if (!proofOk) {
		log.warn('builder_attribution_settle_failed', { run_id: runId, endpoint: settleRow?.endpoint, error: settleRow?.error });
	} else {
		log.info('builder_attribution_ok', { run_id: runId, attributed: signalData.attributed, settle_tx: txSig });
	}

	const note = attributionOk
		? `${signalData.attributed}/${challenged.length} attributed${settleProven ? `, settle ${txSig ? 'proven' : 'ok'}` : settleExecuted ? ', SETTLE_FAILED' : ''}`
		: `ATTRIBUTION_GAP ${gaps.length}: ${signalData.gap_endpoints.join(',')}`;

	return {
		// success = no attribution gap AND (if attempted) the attributed payment
		// settled. amountAtomic reflects only what actually moved on-chain so the
		// loop's daily-spend accounting is exact.
		success: attributionOk && proofOk,
		amountAtomic,
		txSig,
		responseData: {
			expected_code: expectedCode,
			endpoints: rows.map((r) => ({
				endpoint: r.endpoint, challenged: r.challenged, matches: r.matches,
				gap: r.gap, declared_code: r.declared_code, error: r.error,
			})),
			settlement: settleResp,
		},
		signalData,
		valueExtracted: {
			attribution_ok: attributionOk,
			gaps: signalData.gap_endpoints,
			settle_proven: settleProven,
			settle_tx: txSig,
		},
		errorMsg: attributionOk ? (proofOk ? null : `attributed_settle_failed:${settleRow?.error || 'unknown'}`) : `attribution_gap:${signalData.gap_endpoints.join(',')}`,
		note,
	};
}

// Drop the transient scratch fields (challenge body, accept, urls) before the row
// reaches the persistence layer — they're working state, not columns.
function stripScratch(r) {
	const { challenge, accept, _settle, _endpointUrl, _body, ...row } = r;
	return row;
}

async function writeAlert(redis, alert) {
	if (!redis) return;
	try {
		if (alert) {
			await redis.set(REDIS_ALERT_KEY, JSON.stringify(alert), { ex: ALERT_TTL_SECONDS });
		} else {
			await redis.del(REDIS_ALERT_KEY);
		}
	} catch (err) {
		log.warn('builder_attribution_alert_write_failed', { message: err?.message });
	}
}

export const BUILDER_CODE_ATTRIBUTION = Object.freeze({
	endpoint: '/api/x402/*',
	serviceCode: SERVICE_CODE,
	redisAlertKey: REDIS_ALERT_KEY,
	sweepEndpoints: SWEEP_ENDPOINTS.map((e) => e.path),
});
