// api/_lib/x402/pipelines/cosmetic-pricing-audit.js
//
// Avatar Marketplace Dynamic Pricing — autonomous pipeline (self/020).
//
// A pricing-integrity probe across every premium avatar cosmetic. On each run it:
//
//   1. Enumerates the local catalog's premium items (api/_lib/cosmetics.js) and
//      the USDC price each SHOULD settle at (priceUsdcAtomicsOf — server-owned,
//      env-tunable). This is the "DB price" / source of truth.
//   2. Probes the live /api/x402/cosmetic-purchase endpoint for each item's 402
//      challenge and reads the amount it QUOTES. Probing is free — no payment —
//      so the full sweep costs nothing and runs even with no wallet configured.
//   3. Flags drift (quoted ≠ expected) and, critically, UNDERPRICING (quoted <
//      expected) — the bug class that would silently ship revenue loss. The
//      quoted price comes from the deployed endpoint's process/env, so this
//      catches deploy skew and X402_PRICE_COSMETIC_* env misconfiguration that a
//      same-process unit test never could.
//   4. Makes ONE real on-chain x402 purchase of the cheapest premium item to
//      validate the whole quote → pay → settle path end-to-end (the settled
//      amount must equal the quote). Real USDC from the seed wallet, never mocked.
//   5. Records a row per item in cosmetic_pricing_audit (the audit trail) and a
//      summary row in x402_autonomous_log (value_extracted = drift summary).
//
// Tables:
//   cosmetic_pricing_audit  — per-item drift findings (one row per item per run).
//                             Columns receiving extracted value: expected_usdc_atomic,
//                             quoted_usdc_atomic, settled_usdc_atomic, drift,
//                             underpriced.
//   x402_autonomous_log     — one summary row per run; value_extracted (jsonb)
//                             carries { items, drift_count, underpriced_count,
//                             purchased_id, settled_atomic, quote_consistent }.
//
// Downstream consumer: cosmetic_pricing_audit is the pricing-integrity audit
// trail for the Avatar Shop (R21 catalog / R22 checkout). Ops reads it (alongside
// x402_autonomous_log) to gate releases — an `underpriced=true` row is the signal
// that a cosmetic pricing change would ship at a loss and must be held. The latest
// per-item drift state is the canonical "is the deployed shop charging what the
// catalog says" check.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { buildCatalog } from '../../cosmetics.js';
import { normalizeAccountId } from '../../cosmetics-ownership.js';
import {
	loadSeedKeypair,
	payX402,
	bootstrapSolanaContext,
	fetchWithTimeout,
	parseSolanaAccept,
	USDC_MINT,
} from '../pay.js';

const log = logger('x402-cosmetic-pricing-audit');

const ROUTE = '/api/x402/cosmetic-purchase';
// USDC_MINT from pay.js is env-derived and may be unset; fall back to the
// canonical mainnet USDC mint for the log row's asset column.
const ASSET = () => USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Stable, synthetic account the audit grants the one real purchase to. Guest id
// form, never a real buyer — ownership here is an artifact of the probe, not a sale.
const AUDIT_ACCOUNT = normalizeAccountId('g_pricing_audit') || 'g_pricing_audit';

// Every premium catalog item plus the USDC atomics it should settle at locally.
// buildCatalog() is the same source the shop API serves, so `priceUsdcAtomics` is
// exactly the "DB price" the deployed endpoint is expected to quote back.
function premiumCatalog() {
	return buildCatalog()
		.filter((c) => c.premium)
		.map((c) => ({
			id: c.id,
			name: c.name,
			slot: c.slot,
			rarity: c.rarity,
			threePrice: c.price,
			expectedAtomic: Number(c.priceUsdcAtomics),
		}));
}

async function ensureSchema() {
	await sql`
		CREATE TABLE IF NOT EXISTS cosmetic_pricing_audit (
			id                   bigserial PRIMARY KEY,
			run_id               uuid NOT NULL,
			ts                   timestamptz DEFAULT now(),
			cosmetic_id          text NOT NULL,
			name                 text,
			slot                 text,
			rarity               text,
			three_price          numeric(20,4),
			expected_usdc_atomic bigint NOT NULL DEFAULT 0,
			quoted_usdc_atomic   bigint,
			settled_usdc_atomic  bigint,
			drift                boolean NOT NULL DEFAULT false,
			underpriced          boolean NOT NULL DEFAULT false,
			probe_status         text,
			tx_signature         text,
			error                text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS cosmetic_pricing_audit_id_ts ON cosmetic_pricing_audit (cosmetic_id, ts DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS cosmetic_pricing_audit_underpriced ON cosmetic_pricing_audit (underpriced) WHERE underpriced`;
	// The autonomous log predates value_extracted; add it idempotently (mirrors
	// the bazaar-warmup pipeline so concurrent pipelines share one column).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
}

async function recordAuditRow(runId, row) {
	try {
		await sql`
			INSERT INTO cosmetic_pricing_audit
				(run_id, cosmetic_id, name, slot, rarity, three_price,
				 expected_usdc_atomic, quoted_usdc_atomic, settled_usdc_atomic,
				 drift, underpriced, probe_status, tx_signature, error)
			VALUES
				(${runId}, ${row.cosmeticId}, ${row.name || null}, ${row.slot || null},
				 ${row.rarity || null}, ${row.threePrice ?? null},
				 ${row.expectedAtomic || 0}, ${row.quotedAtomic ?? null},
				 ${row.settledAtomic ?? null}, ${!!row.drift}, ${!!row.underpriced},
				 ${row.probeStatus || null}, ${row.txSig || null}, ${row.error || null})
		`;
	} catch (err) {
		log.warn('cosmetic_pricing_audit_insert_failed', { id: row.cosmeticId, message: err?.message });
	}
}

async function recordSummary(runId, { amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${'Avatar Marketplace Dynamic Pricing'}, ${ROUTE},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET()}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'commerce'})
		`;
	} catch (err) {
		log.warn('cosmetic_pricing_audit_summary_failed', { run_id: runId, message: err?.message });
	}
}

// Probe one item's live 402 challenge and read the quoted USDC atomics. Free —
// no X-PAYMENT sent. Never throws: a network/abort fault returns an error shape.
async function probeQuote(origin, item) {
	const url = `${origin}${ROUTE}?id=${encodeURIComponent(item.id)}&account=${encodeURIComponent(AUDIT_ACCOUNT)}`;
	try {
		const res = await fetchWithTimeout(url, {
			method: 'GET',
			headers: { 'user-agent': 'threews-x402-autonomous/1.0' },
		});
		if (res.status !== 402) {
			// Premium items must always present a 402. A 200/4xx is itself an anomaly.
			return { quotedAtomic: null, probeStatus: `http_${res.status}`, error: res.status === 402 ? null : `unexpected_status_${res.status}` };
		}
		const accept = parseSolanaAccept(res.body);
		if (!accept) return { quotedAtomic: null, probeStatus: 'http_402', error: 'no_solana_accept' };
		const quoted = Number(accept.amount || 0);
		if (!Number.isFinite(quoted) || quoted <= 0) {
			return { quotedAtomic: null, probeStatus: 'http_402', error: `bad_quote:${accept.amount}` };
		}
		return { quotedAtomic: quoted, probeStatus: 'http_402', error: null };
	} catch (err) {
		return { quotedAtomic: null, probeStatus: 'fetch_error', error: err?.message || 'fetch_failed' };
	}
}

/**
 * Run the pricing audit. Self-contained: builds its own Solana payment context
 * when one isn't supplied, so it works both inside the per-tick autonomous loop
 * (handed shared blockhash + keypair) and as a direct manual test.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.runId]               correlation id (defaults to fresh uuid)
 * @param {string} [ctx.origin]              base origin for the endpoint
 * @param {import('@solana/web3.js').Keypair} [ctx.buyer] seed keypair (loaded if absent)
 * @param {object} [ctx.conn]                Solana connection (created if absent)
 * @param {string} [ctx.blockhash]           recent blockhash (fetched if absent)
 * @param {object} [ctx.mintInfo]            USDC mint info (fetched if absent)
 * @param {number} [ctx.remainingCapAtomic]  spend ceiling for this run (atomics)
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string,
 *   spentAtomic:number, items:number, driftCount:number, underpricedCount:number,
 *   purchasedId:string|null, txSig:string|null}>}
 */
export async function run(ctx = {}) {
	const t0 = Date.now();
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	// The autonomous loop passes `remainingCap`; standalone callers may pass
	// `remainingCapAtomic`. Accept either, defaulting to unbounded.
	const remainingCap = ctx.remainingCap ?? ctx.remainingCapAtomic ?? Number.POSITIVE_INFINITY;

	const items = premiumCatalog();
	if (items.length === 0) {
		log.info('cosmetic_pricing_audit_no_premium');
		return { ok: true, skipped: true, reason: 'no_premium_items', spentAtomic: 0, items: 0, driftCount: 0, underpricedCount: 0, purchasedId: null, txSig: null };
	}

	// Schema is the only useful sink. If it can't be ensured, abort before any work.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('cosmetic_pricing_audit_schema_failed', { message: err?.message });
		return { ok: false, skipped: true, reason: `schema_failed: ${err?.message}`, spentAtomic: 0, items: items.length, driftCount: 0, underpricedCount: 0, purchasedId: null, txSig: null };
	}

	// ── 1) Free drift sweep across every premium item (no wallet needed) ──────
	const findings = [];
	for (const item of items) {
		const { quotedAtomic, probeStatus, error } = await probeQuote(origin, item);
		// Drift / underpricing only assessable when we actually got a quote.
		const drift = quotedAtomic != null && quotedAtomic !== item.expectedAtomic;
		const underpriced = quotedAtomic != null && quotedAtomic < item.expectedAtomic;
		findings.push({ ...item, quotedAtomic, probeStatus, error, drift, underpriced });
	}

	// ── 2) One real end-to-end purchase: cheapest premium item ────────────────
	// Validates quote → pay → settle consistency with a real on-chain payment.
	// Pick the cheapest by expected price to keep the audit's spend minimal.
	const target = [...items].sort((a, b) => a.expectedAtomic - b.expectedAtomic || a.id.localeCompare(b.id))[0];

	let buyer = ctx.buyer;
	let walletReason = null;
	if (!buyer) {
		try { buyer = loadSeedKeypair(); } catch (err) { walletReason = err.message; }
	}

	let spentAtomic = 0;
	let purchase = null; // payX402 result for the target item
	if (buyer && remainingCap >= target.expectedAtomic) {
		try {
			// Reuse the loop's shared Solana context when handed one; otherwise
			// bootstrap our own (standalone / manual test).
			let { conn, blockhash, mintInfo } = ctx;
			if (!conn || !blockhash || !mintInfo) {
				({ conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
			}
			const url = `${origin}${ROUTE}?id=${encodeURIComponent(target.id)}&account=${encodeURIComponent(AUDIT_ACCOUNT)}`;
			purchase = await payX402({
				url,
				method: 'GET',
				conn, buyer, blockhash, mintInfo,
				remainingCap,
			});
			if (purchase.paid) spentAtomic += purchase.amountAtomic;
		} catch (err) {
			// Infra fault (RPC/preflight). Record it against the target; keep the
			// sweep findings — they're already valuable.
			purchase = { paid: false, success: false, amountAtomic: 0, txSig: null, responseBody: null, errorMsg: err?.message || 'purchase_failed' };
		}
	} else if (!buyer) {
		log.info('cosmetic_pricing_audit_no_wallet', { reason: walletReason });
	}

	// Fold the purchase outcome into the target's finding (settled amount + tx).
	if (purchase) {
		const f = findings.find((x) => x.id === target.id);
		if (f) {
			f.settledAtomic = purchase.paid ? purchase.amountAtomic : null;
			f.txSig = purchase.txSig || null;
			if (purchase.errorMsg) f.error = f.error || purchase.errorMsg;
			// A settled amount that disagrees with the quote is itself drift.
			if (f.settledAtomic != null && f.quotedAtomic != null && f.settledAtomic !== f.quotedAtomic) {
				f.drift = true;
			}
		}
	}

	// ── 3) Persist per-item findings ──────────────────────────────────────────
	for (const f of findings) {
		await recordAuditRow(runId, {
			cosmeticId: f.id,
			name: f.name,
			slot: f.slot,
			rarity: f.rarity,
			threePrice: f.threePrice,
			expectedAtomic: f.expectedAtomic,
			quotedAtomic: f.quotedAtomic,
			settledAtomic: f.settledAtomic ?? null,
			drift: f.drift,
			underpriced: f.underpriced,
			probeStatus: f.probeStatus,
			txSig: f.txSig ?? null,
			error: f.error,
		});
	}

	const driftCount = findings.filter((f) => f.drift).length;
	const underpricedCount = findings.filter((f) => f.underpriced).length;
	const targetFinding = findings.find((x) => x.id === target.id);
	const quoteConsistent = purchase?.paid
		? (targetFinding?.settledAtomic === targetFinding?.quotedAtomic)
		: null;

	// ── 4) Summary row in x402_autonomous_log (always, success or skip) ───────
	const valueExtracted = {
		items: findings.length,
		drift_count: driftCount,
		underpriced_count: underpricedCount,
		purchased_id: purchase?.paid ? target.id : null,
		settled_atomic: purchase?.paid ? purchase.amountAtomic : null,
		quote_consistent: quoteConsistent,
		// Surface the offending items so an alert has them without a re-query.
		underpriced_ids: findings.filter((f) => f.underpriced).map((f) => f.id),
		drift_ids: findings.filter((f) => f.drift).map((f) => f.id),
	};
	const summarySuccess = !walletReason && (purchase ? purchase.success : true);
	const summaryError = walletReason
		? `wallet_unconfigured: ${walletReason}`
		: (purchase && !purchase.success ? purchase.errorMsg : null);

	// This is the authoritative value_extracted row. amount_atomic is recorded as 0
	// here on purpose: the autonomous loop writes its OWN summary row carrying the
	// billed amount (from the returned amountAtomic) and that row is what spend
	// analytics sum — duplicating the amount here would double-count it. The actual
	// settled amount + tx for the purchased item also live in cosmetic_pricing_audit.
	await recordSummary(runId, {
		amountAtomic: 0,
		txSig: purchase?.txSig || null,
		responseData: {
			target: target.id,
			purchase_status: !purchase ? 'not_attempted' : (purchase.paid ? 'paid' : (purchase.free ? 'free' : 'failed')),
			spent_atomic: spentAtomic,
		},
		durationMs: Date.now() - t0,
		success: summarySuccess,
		errorMsg: summaryError,
		valueExtracted,
	});

	if (underpricedCount > 0) {
		log.warn('cosmetic_pricing_underpriced', {
			run_id: runId, count: underpricedCount,
			ids: valueExtracted.underpriced_ids,
		});
	}
	log.info('cosmetic_pricing_audit_complete', {
		run_id: runId,
		items: findings.length,
		drift: driftCount,
		underpriced: underpricedCount,
		purchased: valueExtracted.purchased_id,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	// Two shapes in one object:
	//   • Loop-facing fields (success/amountAtomic/txSig/signalData/errorMsg/skipped/
	//     note) — the autonomous loop reads these to account spend against the daily
	//     cap, set the cooldown, and record its own summary row. amountAtomic mirrors
	//     spentAtomic so the loop decrements the cap by what we actually paid.
	//   • Caller-facing fields (ok/items/driftCount/…) — for the manual test and any
	//     direct invocation that wants the audit outcome.
	return {
		// loop-facing
		success: summarySuccess,
		amountAtomic: spentAtomic,
		txSig: purchase?.txSig || null,
		signalData: valueExtracted,
		errorMsg: summaryError,
		note: `pricing-audit: ${findings.length} items, ${driftCount} drift, ${underpricedCount} underpriced`,
		...(walletReason ? { skipped: true } : {}),
		// caller-facing
		ok: true,
		spentAtomic,
		items: findings.length,
		driftCount,
		underpricedCount,
		purchasedId: valueExtracted.purchased_id,
		reason: walletReason ? 'wallet_unconfigured' : undefined,
	};
}
