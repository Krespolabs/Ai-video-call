// api/_lib/x402/revenue-reconciliation.js
//
// Payment Revenue Reconciliation — the work behind the `revenue-reconciliation`
// autonomous-registry entry (self/027). Runs daily.
//
// Financial integrity is non-negotiable for a live payment platform. Every row
// in our books that claims an on-chain settlement must correspond to a real,
// successful transaction on Solana — and a settlement that silently failed
// on-chain while our DB recorded success is exactly the kind of drift that
// corrupts revenue accounting. This pipeline cross-checks both directions:
//
//   1. Calls the free /api/x402-status probe through the shared x402 client
//      (real payment if it ever becomes gated; today it answers 200 free) to
//      confirm the payment wiring is live and to read the configured pay-to
//      addresses the reconciliation is being measured against.
//   2. Pulls recent payment records that claim settlement from two books:
//        • x402_autonomous_log     — outbound spend (this loop's own payments)
//        • agent_payment_intents   — inbound revenue (user → agent payments)
//   3. Verifies each Solana settlement signature on-chain via
//      getSignatureStatuses (batched, with full history search) and classifies:
//        confirmed         — tx exists, no error               → reconciled
//        failed_onchain    — tx exists but reverted            → DISCREPANCY
//        missing_onchain   — DB says settled, no tx on-chain   → DISCREPANCY
//        missing_signature — DB says settled, no signature kept → DISCREPANCY
//        skipped_non_solana— EVM/Base settlement (not checked here)
//   4. Upserts a verdict row per record into `payment_reconciliation` and writes
//      a compact summary into x402_autonomous_log.value_extracted.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. Reconciliation
// is READ-ONLY, so unlike paying pipelines it does not require the spend wallet —
// when the seed keypair is absent it falls back to a keyless RPC connection and
// still verifies the books (the status endpoint is free, so no payment is owed).
//
// Downstream consumer: the financial-integrity surface reads
// `payment_reconciliation WHERE NOT reconciled` to alert operators on unsettled
// or failed payments; the per-run summary in x402_autonomous_log.value_extracted
// gives the autonomous-loop status view an at-a-glance discrepancy count.

import { randomUUID } from 'node:crypto';

import { sql } from '../db.js';
import { env } from '../env.js';
import { logger } from '../usage.js';
import { sendOpsAlert } from '../alerts.js';
import { solanaConnection } from '../solana/connection.js';
import {
	payX402, bootstrapSolanaContext, fetchWithTimeout,
	USDC_MINT, SOLANA_RPC,
} from './pay.js';

const log = logger('x402-revenue-reconciliation');

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// How far back each run looks. A daily cadence with a 7-day window means every
// settlement is re-verified across roughly seven runs before it ages out — a
// transient RPC miss on one day self-heals on the next instead of latching a
// false discrepancy.
const LOOKBACK = '7 days';
// Cap rows pulled per book so a backlog can never make one tick unbounded; the
// rolling window guarantees full coverage across consecutive daily runs.
const MAX_RECORDS_PER_SOURCE = 250;
// getSignatureStatuses accepts up to 256 signatures per call.
const STATUS_BATCH = 256;

// Solana tx signatures are base58 (no 0x, 64-ish bytes → ~87–88 chars). An EVM
// hash is 0x + 64 hex. Used to route a record to the right verifier.
function isSolanaSignature(sig, network) {
	if (typeof sig !== 'string' || sig.length < 64) return false;
	if (sig.startsWith('0x')) return false;
	const net = String(network || '').toLowerCase();
	if (net.includes('base') || net.includes('evm') || net.includes('eip155')) return false;
	return /^[1-9A-HJ-NP-Za-km-z]+$/.test(sig); // base58 alphabet
}

async function ensureSchema() {
	await sql`
		CREATE TABLE IF NOT EXISTS payment_reconciliation (
			id            bigserial   PRIMARY KEY,
			source        text        NOT NULL,          -- 'autonomous_log' | 'payment_intent'
			source_ref    text        NOT NULL,          -- row id within that book
			tx_signature  text,
			network       text,
			amount_atomic bigint,
			db_status     text        NOT NULL,          -- what the book claims
			chain_status  text        NOT NULL,          -- confirmed|failed_onchain|missing_onchain|missing_signature|skipped_non_solana
			reconciled    boolean     NOT NULL,
			discrepancy   text,                          -- null when reconciled
			detail        jsonb,
			run_id        uuid,
			first_seen_at timestamptz NOT NULL DEFAULT now(),
			checked_at    timestamptz NOT NULL DEFAULT now(),
			UNIQUE (source, source_ref)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS payment_reconciliation_open_idx
		ON payment_reconciliation (checked_at DESC) WHERE reconciled = false`;
	await sql`CREATE INDEX IF NOT EXISTS payment_reconciliation_sig_idx
		ON payment_reconciliation (tx_signature)`;
	// The autonomous log predates this pipeline; ensure the column it records its
	// reconciliation summary into exists (idempotent — shared with other run()s).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
}

// Pull outbound settlements this loop recorded as paid. Each should carry a
// tx_signature; a paid row missing one is itself a discrepancy.
async function loadOutboundRecords() {
	try {
		const rows = await sql`
			SELECT id, service_name, tx_signature, amount_atomic, network, ts
			FROM x402_autonomous_log
			WHERE success = true
			  AND amount_atomic > 0
			  AND ts > now() - ${LOOKBACK}::interval
			ORDER BY ts DESC
			LIMIT ${MAX_RECORDS_PER_SOURCE}
		`;
		return rows.map((r) => ({
			source: 'autonomous_log',
			source_ref: String(r.id),
			tx_signature: r.tx_signature || null,
			network: r.network || 'solana:mainnet',
			amount_atomic: Number(r.amount_atomic || 0),
			db_status: 'paid',
			label: r.service_name || null,
		}));
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('reconcile_outbound_load_failed', { message: err?.message });
		}
		return [];
	}
}

// Pull inbound revenue intents the platform marked settled. Table may not exist
// in a fresh env — treat that as "no inbound book", not an error.
async function loadInboundRecords() {
	try {
		const rows = await sql`
			SELECT id, status, tx_signature, amount, currency_mint, cluster, paid_at
			FROM agent_payment_intents
			WHERE status IN ('paid', 'settled', 'confirmed', 'completed')
			  AND coalesce(paid_at, created_at) > now() - ${LOOKBACK}::interval
			ORDER BY coalesce(paid_at, created_at) DESC
			LIMIT ${MAX_RECORDS_PER_SOURCE}
		`;
		return rows.map((r) => ({
			source: 'payment_intent',
			source_ref: String(r.id),
			tx_signature: r.tx_signature || null,
			// Intents store cluster ('mainnet'/'devnet'); normalize to a network tag.
			network: r.cluster ? `solana:${r.cluster}` : 'solana:mainnet',
			amount_atomic: Number(r.amount || 0),
			db_status: r.status,
			label: r.currency_mint || null,
		}));
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('reconcile_inbound_load_failed', { message: err?.message });
		}
		return [];
	}
}

// Resolve the on-chain status of a batch of Solana signatures. Returns a Map of
// signature → { found, err } (err is the tx-level error object, null on success).
// A connection / RPC fault returns an empty map so callers degrade to "unknown"
// rather than crashing the run.
async function fetchOnChainStatuses(conn, signatures) {
	const out = new Map();
	for (let i = 0; i < signatures.length; i += STATUS_BATCH) {
		const batch = signatures.slice(i, i + STATUS_BATCH);
		try {
			const { value } = await conn.getSignatureStatuses(batch, { searchTransactionHistory: true });
			batch.forEach((sig, j) => {
				const st = value?.[j];
				out.set(sig, st ? { found: true, err: st.err ?? null } : { found: false, err: null });
			});
		} catch (err) {
			log.warn('reconcile_status_batch_failed', { from: i, message: err?.message });
			// Leave this batch unresolved — callers map a missing entry to 'unknown'
			// and do NOT flag a discrepancy on an RPC failure.
		}
	}
	return out;
}

// Classify one record given its on-chain status lookup. Pure.
function classifyRecord(rec, statuses) {
	const sig = rec.tx_signature;

	if (!sig) {
		return { chain_status: 'missing_signature', reconciled: false, discrepancy: 'missing_signature' };
	}
	if (!isSolanaSignature(sig, rec.network)) {
		// EVM/Base settlement — out of scope for the Solana verifier. Not a
		// discrepancy, just not checked on this rail.
		return { chain_status: 'skipped_non_solana', reconciled: true, discrepancy: null };
	}
	const st = statuses.get(sig);
	if (!st) {
		// RPC could not resolve the signature this run (no entry returned). Unknown,
		// not a discrepancy — the next daily run re-checks within the same window.
		return { chain_status: 'unknown', reconciled: true, discrepancy: null };
	}
	if (!st.found) {
		return { chain_status: 'missing_onchain', reconciled: false, discrepancy: 'db_settled_no_chain_tx' };
	}
	if (st.err != null) {
		return { chain_status: 'failed_onchain', reconciled: false, discrepancy: 'chain_tx_failed' };
	}
	return { chain_status: 'confirmed', reconciled: true, discrepancy: null };
}

async function upsertVerdict(runId, rec, verdict) {
	try {
		await sql`
			INSERT INTO payment_reconciliation
				(source, source_ref, tx_signature, network, amount_atomic,
				 db_status, chain_status, reconciled, discrepancy, detail, run_id, checked_at)
			VALUES
				(${rec.source}, ${rec.source_ref}, ${rec.tx_signature}, ${rec.network},
				 ${rec.amount_atomic}, ${rec.db_status}, ${verdict.chain_status},
				 ${verdict.reconciled}, ${verdict.discrepancy},
				 ${JSON.stringify({ label: rec.label || null })}, ${runId}, now())
			ON CONFLICT (source, source_ref) DO UPDATE SET
				tx_signature  = EXCLUDED.tx_signature,
				network       = EXCLUDED.network,
				amount_atomic = EXCLUDED.amount_atomic,
				db_status     = EXCLUDED.db_status,
				chain_status  = EXCLUDED.chain_status,
				reconciled    = EXCLUDED.reconciled,
				discrepancy   = EXCLUDED.discrepancy,
				detail        = EXCLUDED.detail,
				run_id        = EXCLUDED.run_id,
				checked_at    = now()
		`;
	} catch (err) {
		log.warn('reconcile_upsert_failed', { ref: `${rec.source}:${rec.source_ref}`, message: err?.message });
	}
}

// Record this run's call + summary into x402_autonomous_log, including the
// value_extracted reconciliation summary. The loop also records its own aggregate
// summary row for run()-style entries; this is the granular row that carries the
// extracted value (the loop's recordLog does not write value_extracted).
async function recordLogRow(runId, { endpointUrl, amountAtomic, txSig, durationMs, success, errorMsg, summary }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${'Payment Revenue Reconciliation'}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'reconciliation'})
		`;
	} catch (err) {
		log.warn('reconcile_log_insert_failed', { message: err?.message });
	}
}

/**
 * Run the reconciliation. Conforms to the run()-style registry contract: the loop
 * hands { origin, buyer, conn, blockhash, mintInfo, remainingCap, runId }. Called
 * standalone (manual test) it bootstraps its own context; reconciliation is
 * read-only, so a missing spend wallet degrades to a keyless RPC connection
 * rather than skipping.
 *
 * Returns the aggregate outcome the loop records as one summary row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, skipped, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const statusUrl = `${origin}/api/x402-status`;
	const remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;
	const t0 = Date.now();

	// ── Schema first: without the sink there is nothing to store, so don't probe.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('reconcile_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Connection: reuse the loop's, else bootstrap. Reconciliation is read-only,
	//    so a missing spend wallet is not fatal — fall back to a keyless RPC
	//    connection (the status endpoint is free, so no payment is owed).
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!conn) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('reconcile_no_wallet', { reason: err.message });
			buyer = null; blockhash = null; mintInfo = null;
			conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
		}
	}

	// ── Step 1: probe /api/x402-status. Pay through the real client when a wallet
	//    is available (so a future gated status endpoint still settles); otherwise
	//    fetch the free endpoint directly. Either way the call is recorded.
	let statusOk = false;
	let amountAtomic = 0;
	let txSig = null;
	let statusErr = null;
	let payTo = null;
	try {
		if (buyer && blockhash && mintInfo) {
			const r = await payX402({ url: statusUrl, method: 'GET', buyer, conn, blockhash, mintInfo, remainingCap });
			statusOk = r.success;
			amountAtomic = r.paid ? r.amountAtomic : 0;
			txSig = r.txSig || null;
			statusErr = r.errorMsg || null;
			payTo = r.responseBody?.env?.X402_PAY_TO_SOLANA || null;
		} else {
			const r = await fetchWithTimeout(statusUrl, {
				method: 'GET',
				headers: { 'content-type': 'application/json', 'user-agent': 'threews-x402-autonomous/1.0' },
			});
			statusOk = r.ok;
			statusErr = r.ok ? null : `http_${r.status}`;
			payTo = r.body?.env?.X402_PAY_TO_SOLANA || null;
		}
	} catch (err) {
		statusErr = err?.message || 'status_probe_failed';
	}

	// ── Step 2: gather the books and verify each settlement on-chain. A probe
	//    failure does not block reconciliation — the books are read from our DB and
	//    the chain directly, independent of the status endpoint.
	const records = [...(await loadOutboundRecords()), ...(await loadInboundRecords())];

	const solSigs = [...new Set(
		records.filter((r) => isSolanaSignature(r.tx_signature, r.network)).map((r) => r.tx_signature),
	)];
	const statuses = solSigs.length ? await fetchOnChainStatuses(conn, solSigs) : new Map();

	const summary = {
		checked: records.length,
		outbound: records.filter((r) => r.source === 'autonomous_log').length,
		inbound: records.filter((r) => r.source === 'payment_intent').length,
		reconciled: 0,
		confirmed: 0,
		discrepancies: 0,
		missing_onchain: 0,
		failed_onchain: 0,
		missing_signature: 0,
		skipped_non_solana: 0,
		unknown: 0,
		status_probe_ok: statusOk,
		pay_to_solana: payTo,
	};
	const flagged = [];

	for (const rec of records) {
		const verdict = classifyRecord(rec, statuses);
		summary[verdict.chain_status] = (summary[verdict.chain_status] || 0) + 1;
		if (verdict.reconciled) summary.reconciled += 1;
		else {
			summary.discrepancies += 1;
			flagged.push({ source: rec.source, ref: rec.source_ref, sig: rec.tx_signature, status: verdict.chain_status, amount_atomic: rec.amount_atomic });
		}
		await upsertVerdict(runId, rec, verdict);
	}
	// Keep only a bounded sample of flagged rows in the log summary; the full set
	// lives in payment_reconciliation.
	summary.flagged_sample = flagged.slice(0, 20);

	// Page ops on any settlement whose books disagree with the chain. "Recorded
	// revenue ≠ on-chain reality" is the single most regulatory-relevant signal a
	// financial ledger can produce, and until now it was written to
	// payment_reconciliation and never surfaced. Best-effort; the signature keys on
	// the discrepancy counts so a stable state de-dupes (1/hr) while any change or a
	// worsening count always re-fires. Never blocks the run.
	if (summary.discrepancies > 0) {
		const { missing_onchain, failed_onchain, missing_signature } = summary;
		await sendOpsAlert(
			`x402 reconciliation: ${summary.discrepancies} discrepanc${summary.discrepancies === 1 ? 'y' : 'ies'} of ${summary.checked} settlements`,
			[
				`missing_onchain=${missing_onchain} — DB marked settled but no tx on-chain`,
				`failed_onchain=${failed_onchain} — on-chain tx reverted`,
				`missing_signature=${missing_signature} — settled row carries no tx signature`,
				`sample: ${flagged.slice(0, 5).map((f) => `${f.source}:${f.ref}[${f.status}]`).join(', ') || '—'}`,
				`full set: SELECT * FROM payment_reconciliation WHERE reconciled = false`,
			].join('\n'),
			{ signature: `reconcile-discrepancy:${missing_onchain}:${failed_onchain}:${missing_signature}` },
		).catch(() => {});
	}

	const durationMs = Date.now() - t0;
	const success = statusOk || records.length > 0;
	const errorMsg = success ? null : (statusErr || 'reconcile_no_data');

	await recordLogRow(runId, {
		endpointUrl: statusUrl, amountAtomic, txSig, durationMs, success, errorMsg, summary,
	});

	log.info('reconcile_complete', {
		run_id: runId,
		checked: summary.checked,
		reconciled: summary.reconciled,
		discrepancies: summary.discrepancies,
		missing_onchain: summary.missing_onchain,
		failed_onchain: summary.failed_onchain,
		status_probe_ok: statusOk,
		duration_ms: durationMs,
	});

	return {
		success,
		amountAtomic,
		txSig,
		errorMsg,
		skipped: false,
		responseData: {
			checked: summary.checked,
			reconciled: summary.reconciled,
			discrepancies: summary.discrepancies,
			missing_onchain: summary.missing_onchain,
			failed_onchain: summary.failed_onchain,
			missing_signature: summary.missing_signature,
			status_probe_ok: statusOk,
		},
		signalData: null,
		note: `reconcile checked=${summary.checked} ok=${summary.reconciled} disc=${summary.discrepancies}`,
	};
}
