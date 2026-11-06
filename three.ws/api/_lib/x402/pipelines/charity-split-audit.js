// api/_lib/x402/pipelines/charity-split-audit.js
//
// Charity Split Audit — autonomous pipeline (self/charity-split).
//
// "Ensures donation promises are kept." A merchant on the x402 Merchant Console
// (/api/x402-merchant) can configure a charity split — a basis-point share of
// every settled payment that the drop-in checkout appends, as a second
// transferChecked to the cause's wallet, onto the same buyer-signed transaction
// (see api/x402-checkout.js validateTip + handlePrepare). This audit verifies
// that promise end-to-end, once a week:
//
//   1. FREE config sweep (no wallet needed) — reads every charity-enabled
//      merchant from x402_merchant_settings and validates the donation promise
//      is actually routable: a cause address present and well-formed for its
//      declared chain, a non-zero share, a payout configured, and the cause
//      wallet distinct from the merchant payout (the checkout rejects a tip whose
//      recipient equals the payment recipient, so that config would silently
//      drop the donation). A broken config is a donation promise the platform
//      makes to buyers but can never keep — the exact thing this audit surfaces.
//
//   2. One REAL on-chain canary payment WITH a charity split — exercises the
//      PRODUCTION giving code path, not a reimplementation. It probes the cheap
//      $0.001 402-gated dance-tip for a live challenge, computes the split
//      (floor(amount × bps / 10000)) exactly as a buyer's checkout would, then
//      asks the real /api/x402-checkout prepare endpoint to build the payment
//      transaction WITH that charity tip, signs it with the seed wallet, encodes
//      it via the real encode endpoint, and settles it through the facilitator
//      (the sponsor pays the SOL fee — the seed wallet needs no SOL, same as
//      every other loop payment). After settlement it reads the transaction back
//      from chain (getParsedTransaction) and asserts the charity wallet's
//      transferChecked leg landed with the EXACT computed atomics. A regression
//      in the charity-routing code — the tip silently dropped, mis-amounted, or
//      mis-routed — flips charity_routed to false.
//
// The canary cause wallet defaults to the seed wallet itself (X402_CHARITY_AUDIT_
// ADDRESS_SOLANA overrides it with a platform-owned cause wallet): a safe
// self-routed split with zero net outflow that still fully exercises the split
// arithmetic, the second transferChecked leg, and on-chain verification. Set the
// override to prove distinct-recipient routing with a real balance delta.
//
// Tables:
//   charity_split_audit  — one row per charity-enabled merchant (kind='config')
//                          plus one row for the on-chain canary (kind='canary')
//                          per run. Columns receiving extracted value:
//                          config_valid, broken_reason, expected_split_atomic,
//                          routed_split_atomic, charity_routed, tx_signature.
//   x402_autonomous_log  — one summary row per run; value_extracted (jsonb)
//                          carries { merchants_audited, broken_count, broken_ids,
//                          canary }. The pipeline writes this row itself (amount 0,
//                          full value_extracted) so a direct manual invocation
//                          produces a log row; the loop writes its own billed row.
//
// Downstream consumer: charity_split_audit is the giving-integrity audit trail.
// Ops reads it (WHERE NOT config_valid OR NOT charity_routed) to alert when a
// merchant's donation promise is unroutable or the production charity-routing
// code stops delivering the split on-chain — before a buyer is told their
// payment gave to a cause that never received it.
//
// No mocks. The config sweep reads live merchant rows; the canary makes a real
// on-chain USDC payment through the real checkout endpoints and verifies the
// settled transaction on-chain.

import { randomUUID } from 'node:crypto';
import {
	PublicKey,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import {
	loadSeedKeypair,
	bootstrapSolanaContext,
	fetchWithTimeout,
	parseSolanaAccept,
	USDC_MINT,
} from '../pay.js';

const log = logger('x402-charity-split-audit');

// Informational service identity for the log row. The work spans the merchant
// console (config source) + the checkout endpoints (the routing code under test).
const SERVICE_NAME = 'Charity Split Audit';
const ROUTE = '/api/x402-merchant';
// The cheap real 402-gated endpoint the canary settles its base payment against.
// $0.001 USDC; the facilitator sponsors the SOL fee (accept.extra.feePayer).
const PROBE_PATH = '/api/x402/dance-tip?dancer=4&dance=hiphop';
const CHECKOUT_PATH = '/api/x402-checkout';
// USDC_MINT from pay.js is env-derived; fall back to canonical mainnet USDC for
// the log row's asset column.
const ASSET = () => USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Audit canary share (basis points). Defaults to 5%; clamped to a routable,
// non-zero share so the computed split is always > 0 and verifiable on-chain.
function auditBps() {
	const raw = Number(process.env.X402_CHARITY_AUDIT_BPS || 500);
	if (!Number.isFinite(raw)) return 500;
	return Math.min(10000, Math.max(1, Math.trunc(raw)));
}

// floor(amount × bps / 10000) — the exact split the checkout computes for a
// charity-enabled merchant. BigInt math: no float drift at the atom.
export function computeSplit(amountAtomic, bps) {
	return (BigInt(amountAtomic) * BigInt(bps)) / 10000n;
}

export function isValidAddress(chain, address) {
	if (!address) return false;
	if (chain === 'base') return EVM_ADDR_RE.test(address);
	if (chain === 'solana') return SOLANA_ADDR_RE.test(address);
	return false;
}

// Classify whether a charity-enabled merchant's donation promise is actually
// routable. Pure + exported so the broken-config rules — the heart of "ensures
// donation promises are kept" — are unit-testable without a DB. A merchant row
// carries charity_chain, charity_address, charity_bps, payout_evm, payout_solana.
// Returns { configValid, reason, chain, bps, payout, expectedSplitAtomic } where
// reason is null when valid and a stable machine code otherwise. expectedSplit
// is what a $1.00 (1_000_000 atomics) payment would route (null when invalid).
export function classifyCharityConfig(m) {
	const chain = m.charity_chain || null;
	const payout = chain === 'base'
		? m.payout_evm
		: chain === 'solana'
			? m.payout_solana
			: (m.payout_solana || m.payout_evm);
	const bps = Number(m.charity_bps || 0);

	let reason = null;
	if (!chain) reason = 'missing_charity_chain';
	else if (!m.charity_address) reason = 'missing_charity_address';
	else if (!isValidAddress(chain, m.charity_address)) reason = `invalid_${chain}_charity_address`;
	else if (bps <= 0) reason = 'zero_bps';
	else if (bps > 10000) reason = 'bps_over_100pct';
	else if (!payout) reason = 'missing_payout';
	else if (m.charity_address === payout) reason = 'charity_equals_payout'; // checkout drops this tip

	const configValid = reason === null;
	return {
		configValid,
		reason,
		chain,
		bps,
		payout: payout || null,
		expectedSplitAtomic: configValid ? Number(computeSplit(1_000_000, bps)) : null,
	};
}

let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS charity_split_audit (
			id                      bigserial PRIMARY KEY,
			run_id                  uuid NOT NULL,
			ts                      timestamptz DEFAULT now(),
			merchant_id             text NOT NULL,
			kind                    text NOT NULL DEFAULT 'config',
			charity_name            text,
			charity_chain           text,
			charity_address         text,
			charity_bps             int,
			payout_address          text,
			config_valid            boolean NOT NULL DEFAULT false,
			broken_reason           text,
			reference_amount_atomic bigint,
			expected_split_atomic   bigint,
			routed_split_atomic     bigint,
			charity_routed          boolean,
			tx_signature            text,
			error                   text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS charity_split_audit_merchant_ts ON charity_split_audit (merchant_id, ts DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS charity_split_audit_broken ON charity_split_audit (config_valid) WHERE NOT config_valid`;
	await sql`CREATE INDEX IF NOT EXISTS charity_split_audit_unrouted ON charity_split_audit (charity_routed) WHERE charity_routed = false`;
	// Mirror the loop: the autonomous log predates value_extracted on some installs.
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

async function recordAuditRow(runId, row) {
	try {
		await sql`
			INSERT INTO charity_split_audit
				(run_id, merchant_id, kind, charity_name, charity_chain, charity_address,
				 charity_bps, payout_address, config_valid, broken_reason,
				 reference_amount_atomic, expected_split_atomic, routed_split_atomic,
				 charity_routed, tx_signature, error)
			VALUES
				(${runId}, ${row.merchantId}, ${row.kind || 'config'}, ${row.charityName || null},
				 ${row.charityChain || null}, ${row.charityAddress || null},
				 ${row.charityBps ?? null}, ${row.payoutAddress || null},
				 ${!!row.configValid}, ${row.brokenReason || null},
				 ${row.referenceAmountAtomic ?? null}, ${row.expectedSplitAtomic ?? null},
				 ${row.routedSplitAtomic ?? null}, ${row.charityRouted ?? null},
				 ${row.txSig || null}, ${row.error || null})
		`;
	} catch (err) {
		log.warn('charity_split_audit_insert_failed', { merchant: row.merchantId, message: err?.message });
	}
}

async function recordSummary(runId, { txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${SERVICE_NAME}, ${ROUTE},
				 ${'solana:mainnet'}, ${0}, ${ASSET()}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'finance'})
		`;
	} catch (err) {
		log.warn('charity_split_audit_summary_failed', { run_id: runId, message: err?.message });
	}
}

// ── Free config sweep ─────────────────────────────────────────────────────────
// Read every charity-enabled merchant and classify whether its donation promise
// is actually routable. Read-only: runs even with no wallet configured.
async function sweepMerchantConfigs(runId) {
	let rows = [];
	try {
		rows = await sql`
			select owner_user_id, charity_name, charity_chain, charity_address,
			       charity_bps, payout_evm, payout_solana
			from x402_merchant_settings
			where charity_enabled = true
		`;
	} catch (err) {
		// Table absent on a fresh install — no merchants to audit yet, not a fault.
		if (!String(err?.message || '').includes('does not exist')) {
			log.warn('charity_split_audit_merchant_query_failed', { message: err?.message });
		}
		return { audited: 0, broken: [] };
	}

	const broken = [];
	for (const m of rows) {
		const c = classifyCharityConfig(m);
		if (!c.configValid) broken.push(m.owner_user_id);

		await recordAuditRow(runId, {
			merchantId: m.owner_user_id,
			kind: 'config',
			charityName: m.charity_name,
			charityChain: c.chain,
			charityAddress: m.charity_address,
			charityBps: c.bps,
			payoutAddress: c.payout,
			configValid: c.configValid,
			brokenReason: c.reason,
			referenceAmountAtomic: 1_000_000,
			expectedSplitAtomic: c.expectedSplitAtomic,
			routedSplitAtomic: null,
			charityRouted: null,
			error: null,
		});
	}

	if (broken.length) {
		log.warn('charity_split_broken_configs', { run_id: runId, count: broken.length });
	}
	return { audited: rows.length, broken };
}

// Walk a parsed transaction (outer + inner instructions) and collect every
// SPL-Token transfer leg as { destination, amount } so the audit can confirm the
// charity leg and the base leg both landed with their exact atomics.
export function collectTokenTransfers(parsedTx) {
	const legs = [];
	const push = (ix) => {
		if (!ix || ix.program !== 'spl-token' || !ix.parsed) return;
		const t = ix.parsed.type;
		if (t !== 'transferChecked' && t !== 'transfer') return;
		const info = ix.parsed.info || {};
		const amount = t === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
		if (info.destination && amount != null) legs.push({ destination: info.destination, amount: String(amount) });
	};
	const msg = parsedTx?.transaction?.message;
	for (const ix of msg?.instructions || []) push(ix);
	for (const inner of parsedTx?.meta?.innerInstructions || []) {
		for (const ix of inner.instructions || []) push(ix);
	}
	return legs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the settled transaction back from chain and verify the charity + base
// legs landed with their exact atomics. Retries briefly — a confirmed tx can lag
// getParsedTransaction by a slot or two.
async function verifyOnChain(conn, sig, { charityAta, payToAta, expectedSplit, baseAmount }) {
	for (let attempt = 0; attempt < 4; attempt++) {
		let tx = null;
		try {
			tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
		} catch { /* transient — retry */ }
		if (tx) {
			const legs = collectTokenTransfers(tx);
			const charityLeg = legs.find((l) => l.destination === charityAta && l.amount === String(expectedSplit));
			const baseLeg = legs.find((l) => l.destination === payToAta && l.amount === String(baseAmount));
			return {
				found: true,
				charityRouted: !!charityLeg,
				baseRouted: !!baseLeg,
				routedSplit: charityLeg ? Number(charityLeg.amount) : null,
				reverted: !!tx.meta?.err,
			};
		}
		await sleep(1500);
	}
	return { found: false, charityRouted: false, baseRouted: false, routedSplit: null, reverted: false };
}

// ── Real on-chain canary through the production checkout code ───────────────────
async function runCanary(ctx, { origin, runId, remainingCap }) {
	let buyer = ctx.buyer;
	let walletReason = null;
	if (!buyer) {
		try { buyer = loadSeedKeypair(); } catch (err) { walletReason = err.message; }
	}
	if (!buyer) {
		log.info('charity_split_audit_no_wallet', { reason: walletReason });
		return { attempted: false, skipped: true, reason: 'wallet_unconfigured', walletReason };
	}

	// Bootstrap Solana context if the loop didn't hand us one (standalone test).
	let conn = ctx.conn;
	try {
		if (!conn) ({ conn } = await bootstrapSolanaContext({ buyer }));
	} catch (err) {
		return { attempted: false, skipped: true, reason: `solana_bootstrap_failed: ${err?.message}` };
	}

	// 1) Probe the cheap 402 endpoint for a live challenge.
	const probeUrl = `${origin}${PROBE_PATH}`;
	const probe = await fetchWithTimeout(probeUrl, {
		method: 'GET',
		headers: { 'user-agent': 'threews-x402-autonomous/1.0' },
	});
	if (probe.status !== 402) {
		return { attempted: false, skipped: true, reason: `probe_not_402:${probe.status}` };
	}
	const accept = parseSolanaAccept(probe.body);
	if (!accept) return { attempted: false, skipped: true, reason: 'no_solana_accept' };
	if (!USDC_MINT || accept.asset !== USDC_MINT) {
		return { attempted: false, skipped: true, reason: `unexpected_asset:${accept.asset}` };
	}
	if (!accept.extra?.feePayer) return { attempted: false, skipped: true, reason: 'missing_fee_payer' };

	const baseAmount = Number(accept.amount || 0);
	const bps = auditBps();
	const split = Number(computeSplit(baseAmount, bps));
	if (split <= 0) {
		// Base too small for this share to produce a verifiable split — nothing to prove.
		return { attempted: false, skipped: true, reason: 'split_rounds_to_zero', baseAmount, bps };
	}

	const charityAddress = (process.env.X402_CHARITY_AUDIT_ADDRESS_SOLANA || '').trim()
		|| buyer.publicKey.toBase58();
	if (!SOLANA_ADDR_RE.test(charityAddress)) {
		return { attempted: false, skipped: true, reason: 'invalid_canary_charity_address' };
	}

	// Cap guard: the seed wallet moves base + split USDC this run.
	const totalSpend = baseAmount + split;
	if (totalSpend > remainingCap) {
		return { attempted: false, skipped: true, reason: 'cap_would_exceed', baseAmount, split };
	}

	const charityPubkey = new PublicKey(charityAddress);
	const mint = new PublicKey(accept.asset);
	const payTo = new PublicKey(accept.payTo);
	const charityAta = getAssociatedTokenAddressSync(mint, charityPubkey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
	const payToAta = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();

	// 2) PRODUCTION code builds the payment tx WITH the charity tip leg.
	const prepRes = await fetchWithTimeout(`${origin}${CHECKOUT_PATH}?action=prepare`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'user-agent': 'threews-x402-autonomous/1.0' },
		body: JSON.stringify({
			accept,
			buyer: buyer.publicKey.toBase58(),
			tips: [{ to: charityAddress, amount: String(split) }],
		}),
	});
	if (!prepRes.ok || !prepRes.body?.tx_base64) {
		return { attempted: true, success: false, reason: 'prepare_failed', status: prepRes.status, body: prepRes.body, baseAmount, split, bps, charityAddress };
	}

	// 3) Sign the prepared tx with the seed wallet (buyer slot). The facilitator
	//    co-signs the fee-payer slot + broadcasts at settle.
	let signedTxBase64;
	try {
		const vtx = VersionedTransaction.deserialize(Buffer.from(prepRes.body.tx_base64, 'base64'));
		vtx.sign([buyer]);
		signedTxBase64 = Buffer.from(vtx.serialize()).toString('base64');
	} catch (err) {
		return { attempted: true, success: false, reason: `sign_failed: ${err?.message}`, baseAmount, split, bps, charityAddress };
	}

	// 4) PRODUCTION code encodes the signed tx into the X-PAYMENT envelope (this
	//    also re-confirms the base leg pays payTo before it goes on the wire).
	const encRes = await fetchWithTimeout(`${origin}${CHECKOUT_PATH}?action=encode`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'user-agent': 'threews-x402-autonomous/1.0' },
		body: JSON.stringify({ accept, signed_tx_base64: signedTxBase64, resource_url: probeUrl }),
	});
	if (!encRes.ok || !encRes.body?.x_payment) {
		return { attempted: true, success: false, reason: 'encode_failed', status: encRes.status, body: encRes.body, baseAmount, split, bps, charityAddress };
	}

	// 5) Settle: replay the paid endpoint with the payment header.
	const paidRes = await fetchWithTimeout(probeUrl, {
		method: 'GET',
		headers: {
			'user-agent': 'threews-x402-autonomous/1.0',
			'x-payment': encRes.body.x_payment,
		},
	});
	if (!paidRes.ok) {
		return { attempted: true, success: false, reason: `settle_failed:http_${paidRes.status}`, body: paidRes.body, baseAmount, split, bps, charityAddress };
	}

	// Resolve the settled signature from the X-PAYMENT-RESPONSE header.
	let txSig = null;
	const respHeader = paidRes.headers?.get?.('x-payment-response');
	if (respHeader) {
		try { txSig = JSON.parse(Buffer.from(respHeader, 'base64').toString('utf8'))?.transaction || null; } catch { /* non-fatal */ }
	}
	if (!txSig) {
		// Settled but no signature to verify against — report the spend, can't verify routing.
		return { attempted: true, success: true, charityRouted: false, reason: 'no_settlement_signature', baseAmount, split, bps, charityAddress, charityAta, payToAta, spentAtomic: totalSpend, txSig: null };
	}

	// 6) Verify on-chain: the charity leg landed with the exact computed atomics.
	const verify = await verifyOnChain(conn, txSig, { charityAta, payToAta, expectedSplit: split, baseAmount });

	return {
		attempted: true,
		success: true,
		spentAtomic: totalSpend,
		txSig,
		baseAmount,
		split,
		bps,
		charityAddress,
		charityAta,
		payToAta,
		charityRouted: verify.charityRouted,
		baseRouted: verify.baseRouted,
		routedSplit: verify.routedSplit,
		onchainFound: verify.found,
		reverted: verify.reverted,
	};
}

/**
 * Run the charity split audit. Self-contained: works inside the per-tick
 * autonomous loop (handed shared buyer/conn) or as a direct manual test.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.runId]
 * @param {string} [ctx.origin]
 * @param {import('@solana/web3.js').Keypair} [ctx.buyer]
 * @param {object} [ctx.conn]
 * @param {number} [ctx.remainingCap]
 * @returns {Promise<object>} loop-facing { success, amountAtomic, txSig, signalData, errorMsg, note } + caller-facing fields
 */
export async function run(ctx = {}) {
	const t0 = Date.now();
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const remainingCap = ctx.remainingCap ?? ctx.remainingCapAtomic ?? Number.POSITIVE_INFINITY;

	try {
		await ensureSchema();
	} catch (err) {
		log.warn('charity_split_audit_schema_failed', { message: err?.message });
		return { success: false, skipped: true, errorMsg: `schema_failed: ${err?.message}`, amountAtomic: 0, txSig: null };
	}

	// 1) Free config sweep across every charity-enabled merchant.
	const sweep = await sweepMerchantConfigs(runId);

	// 2) One real on-chain canary through the production checkout code.
	const canary = await runCanary(ctx, { origin, runId, remainingCap });

	// Persist the canary as its own audit row.
	if (canary.attempted) {
		await recordAuditRow(runId, {
			merchantId: 'canary',
			kind: 'canary',
			charityName: 'audit-canary',
			charityChain: 'solana',
			charityAddress: canary.charityAddress || null,
			charityBps: canary.bps ?? auditBps(),
			payoutAddress: canary.payToAta || null,
			configValid: true,
			brokenReason: null,
			referenceAmountAtomic: canary.baseAmount ?? null,
			expectedSplitAtomic: canary.split ?? null,
			routedSplitAtomic: canary.routedSplit ?? null,
			charityRouted: canary.charityRouted ?? null,
			txSig: canary.txSig || null,
			error: canary.success === false ? canary.reason : (canary.charityRouted === false ? 'charity_leg_not_found_on_chain' : null),
		});
	}

	const spentAtomic = Number(canary.spentAtomic) || 0;
	const valueExtracted = {
		merchants_audited: sweep.audited,
		broken_count: sweep.broken.length,
		broken_ids: sweep.broken,
		canary: canary.attempted
			? {
				settled: canary.success === true,
				base_atomic: canary.baseAmount ?? null,
				bps: canary.bps ?? null,
				split_atomic: canary.split ?? null,
				charity_routed: canary.charityRouted ?? null,
				routed_split_atomic: canary.routedSplit ?? null,
				onchain_found: canary.onchainFound ?? null,
				tx: canary.txSig || null,
				charity_address: canary.charityAddress || null,
				reason: canary.success === false ? canary.reason : undefined,
			}
			: { skipped: true, reason: canary.reason },
	};

	// A failed/unrouted canary or any broken merchant config is the alert signal.
	const canaryOk = !canary.attempted ? true : (canary.success === true && canary.charityRouted !== false);
	const success = canaryOk; // broken merchant configs are flagged in-row, not a loop failure
	const errorMsg = canary.attempted && canary.success === false
		? `canary_failed: ${canary.reason}`
		: (canary.charityRouted === false ? 'canary_charity_not_routed' : null);

	// Own summary row (amount 0, full value_extracted) so a direct manual call
	// produces a log row; the loop adds its own billed row from amountAtomic.
	await recordSummary(runId, {
		txSig: canary.txSig || null,
		responseData: {
			merchants_audited: sweep.audited,
			broken_count: sweep.broken.length,
			canary_status: !canary.attempted ? 'skipped' : (canary.success ? (canary.charityRouted ? 'routed' : 'unrouted') : 'failed'),
			spent_atomic: spentAtomic,
		},
		durationMs: Date.now() - t0,
		success,
		errorMsg,
		valueExtracted,
	});

	if (canary.charityRouted === false) {
		log.warn('charity_split_canary_unrouted', { run_id: runId, tx: canary.txSig, split: canary.split, reason: canary.reason });
	}
	log.info('charity_split_audit_complete', {
		run_id: runId,
		merchants: sweep.audited,
		broken: sweep.broken.length,
		canary: !canary.attempted ? `skip:${canary.reason}` : (canary.success ? (canary.charityRouted ? 'routed' : 'unrouted') : `fail:${canary.reason}`),
		spent_usdc: (spentAtomic / 1e6).toFixed(6),
	});

	return {
		// loop-facing — the loop accounts amountAtomic against the daily cap and
		// writes its billed summary row; signalData (compact) lands in signal_data.
		success,
		amountAtomic: spentAtomic,
		txSig: canary.txSig || null,
		signalData: {
			merchants_audited: sweep.audited,
			broken_count: sweep.broken.length,
			canary_charity_routed: canary.charityRouted ?? null,
			canary_split_atomic: canary.split ?? null,
		},
		errorMsg,
		note: `charity-audit: ${sweep.audited} merchants, ${sweep.broken.length} broken, canary ${!canary.attempted ? `skip(${canary.reason})` : (canary.charityRouted ? 'routed' : (canary.success ? 'unrouted' : 'failed'))}`,
		...(canary.skipped && !canary.attempted && sweep.audited === 0 ? { skipped: true } : {}),
		// caller-facing
		ok: true,
		merchantsAudited: sweep.audited,
		brokenCount: sweep.broken.length,
		canary,
		spentAtomic,
	};
}

export default { run };
