// Usage metering — the one primitive every priced action calls after it
// succeeds. It writes a single, idempotent row to the usage_events ledger
// (kind='metered') carrying the money the action moved and a back-link to the
// settlement that paid for it. That ledger is what produces receipts, the
// periodic invoice statement, and the reconciliation pass.
//
// WHY ONE PRIMITIVE: before this, a charge settled (token_payments) but nothing
// recorded WHAT was billed in a form a customer can read, audit, and reconcile.
// recordUsage() closes that gap with a single contract every rail shares.
//
// IDEMPOTENCY (the no-double-spend bar): a retried settlement must meter exactly
// once. Every metered row carries an idempotency_key (defaulting to the
// settlement ref) with a UNIQUE partial index; the INSERT uses
// ON CONFLICT DO NOTHING, so a duplicate charge resolves to {metered:false}
// instead of a second ledger line.

import { sql } from './db.js';
import { calculateFee } from './fee.js';
import { CATALOG, POLICY } from './pricing/catalog.js';

const USDC_DECIMALS = 6;

/** Atomic USDC (6dp) → human USD string, e.g. 150000n → "0.15". */
export function atomicsToUsd(atomics) {
	return (Number(atomics || 0) / 10 ** USDC_DECIMALS).toFixed(2);
}

// The platform's cut of a charge, in atomics. For marketplace sales the platform
// takes the fee-bps slice and the rest is the seller's; for consumption/scarcity
// actions (no seller) the platform keeps the whole price.
function platformFeeAtomics({ priceAtomics, policy }) {
	if (policy === POLICY.MARKETPLACE) {
		return calculateFee(priceAtomics).fee;
	}
	return priceAtomics;
}

/**
 * Record one metered usage event. Idempotent on the settlement (or an explicit
 * idempotency key) — a retried charge for the same settlement meters once.
 *
 * @param {object} p
 * @param {string|null} p.userId            owning user (nullable for wallet-only charges)
 * @param {string} p.action                 catalog action id (e.g. 'forge.high')
 * @param {number} [p.units=1]              quantity billed
 * @param {number|bigint} p.priceUsdcAtomics  gross price in USDC atomics (6dp), discount already applied
 * @param {number|bigint} [p.feeUsdcAtomics]  platform cut; derived from the action's policy when omitted
 * @param {number} [p.discountBps=0]        holder-tier discount applied to reach the price (0–10000)
 * @param {string} p.settlementRef          token_payments.id / tx signature / AWS allocation id
 * @param {'three'|'x402'|'aws'|'card'} [p.settlementKind='three']
 * @param {string|null} [p.agentId]         agent attribution, when the charge ran for an agent
 * @param {string} [p.idempotencyKey]       overrides the default `${kind}:${settlementRef}` key
 * @param {object} [p.meta]                 extra audit context (sealed into meta jsonb)
 * @returns {Promise<{ id: number|null, metered: boolean, duplicate: boolean }>}
 */
export async function recordUsage({
	userId = null,
	action,
	units = 1,
	priceUsdcAtomics,
	feeUsdcAtomics,
	discountBps = 0,
	settlementRef,
	settlementKind = 'three',
	agentId = null,
	idempotencyKey,
	meta = {},
}) {
	if (!action || typeof action !== 'string') {
		throw Object.assign(new Error('recordUsage: action is required'), { code: 'meter_bad_action' });
	}
	if (!settlementRef) {
		throw Object.assign(new Error('recordUsage: settlementRef is required'), { code: 'meter_no_settlement' });
	}

	const price = BigInt(Math.max(0, Math.trunc(Number(priceUsdcAtomics) || 0)));
	const policy = CATALOG[action]?.policy ?? POLICY.CONSUMPTION;
	const fee =
		feeUsdcAtomics != null
			? BigInt(Math.max(0, Math.trunc(Number(feeUsdcAtomics))))
			: BigInt(platformFeeAtomics({ priceAtomics: Number(price), policy }));

	const key = idempotencyKey || `${settlementKind}:${settlementRef}`;
	const u = Math.max(1, Math.trunc(Number(units) || 1));
	const disc = Math.max(0, Math.min(10000, Math.trunc(Number(discountBps) || 0)));

	const [row] = await sql`
		insert into usage_events
			(user_id, agent_id, kind, tool, status, meta,
			 meter_action, units, price_usdc_atomics, fee_usdc_atomics,
			 discount_bps, settlement_ref, settlement_kind, idempotency_key)
		values
			(${userId}, ${agentId}, 'metered', ${action}, 'ok', ${JSON.stringify(meta || {})}::jsonb,
			 ${action}, ${u}, ${price.toString()}, ${fee.toString()},
			 ${disc}, ${String(settlementRef)}, ${settlementKind}, ${key})
		on conflict (idempotency_key) do nothing
		returning id
	`;

	if (row) return { id: Number(row.id), metered: true, duplicate: false };
	return { id: null, metered: false, duplicate: true };
}

/**
 * Fire-and-forget metering that never throws — for hot paths that must not fail
 * a settled charge just because the ledger write hiccuped. Logs and swallows.
 * The reconciliation pass catches any settlement that ended up unmetered.
 */
export async function recordUsageSafe(args) {
	try {
		return await recordUsage(args);
	} catch (err) {
		console.error('[metering] recordUsage failed', { action: args?.action, ref: args?.settlementRef, error: err?.message });
		return { id: null, metered: false, duplicate: false, error: err?.message };
	}
}

const LABEL = (action) => CATALOG[action]?.label ?? action;

/**
 * Roll a user's metered usage over a window into an invoice statement: per-action
 * line items plus the statement totals. Every atomic is summed in Postgres
 * (numeric) so the math never drifts. Line totals sum exactly to the statement
 * total — the invariant the tests assert.
 *
 * @returns {Promise<{ period:{from,to}, line_items:Array, totals:object }>}
 */
export async function rollupInvoice({ userId, from, to }) {
	const rows = await sql`
		select
			meter_action                                  as action,
			count(*)::int                                 as count,
			coalesce(sum(units), 0)::bigint               as units,
			coalesce(sum(price_usdc_atomics), 0)::numeric as gross_atomics,
			coalesce(sum(fee_usdc_atomics), 0)::numeric   as fee_atomics,
			coalesce(round(avg(discount_bps)), 0)::int    as discount_bps
		from usage_events
		where user_id = ${userId}
		  and kind = 'metered'
		  and created_at >= ${from}
		  and created_at < ${to}
		group by meter_action
		order by gross_atomics desc
	`;

	let gross = 0n;
	let fee = 0n;
	let count = 0;
	const line_items = rows.map((r) => {
		const g = BigInt(r.gross_atomics);
		const f = BigInt(r.fee_atomics);
		gross += g;
		fee += f;
		count += r.count;
		return {
			action: r.action,
			label: LABEL(r.action),
			count: r.count,
			units: Number(r.units),
			gross_atomics: g.toString(),
			fee_atomics: f.toString(),
			net_atomics: (g - f).toString(),
			gross_usd: atomicsToUsd(g),
			fee_usd: atomicsToUsd(f),
			discount_bps: r.discount_bps,
		};
	});

	return {
		period: { from: from instanceof Date ? from.toISOString() : from, to: to instanceof Date ? to.toISOString() : to },
		line_items,
		totals: {
			charge_count: count,
			gross_atomics: gross.toString(),
			fee_atomics: fee.toString(),
			net_atomics: (gross - fee).toString(),
			gross_usd: atomicsToUsd(gross),
			fee_usd: atomicsToUsd(fee),
			currency: 'USDC',
		},
	};
}

/**
 * A single charge receipt: the metered row joined to its on-chain settlement so
 * the customer sees action, units, price, fee, discount, the settlement tx, and
 * the timestamp. Owner-scoped — a user only reads their own usage.
 *
 * @returns {Promise<object|null>}
 */
export async function getReceipt({ userId, eventId }) {
	const [row] = await sql`
		select
			ue.id, ue.meter_action, ue.units, ue.price_usdc_atomics, ue.fee_usdc_atomics,
			ue.discount_bps, ue.settlement_ref, ue.settlement_kind, ue.created_at,
			tp.tx_signature, tp.network, tp.mint, tp.total_atomics as settled_atomics,
			tp.price_usd as token_price_usd
		from usage_events ue
		left join token_payments tp
			on ue.settlement_kind = 'three' and tp.id::text = ue.settlement_ref
		where ue.id = ${eventId}
		  and ue.kind = 'metered'
		  and ue.user_id = ${userId}
	`;
	if (!row) return null;

	const gross = BigInt(row.price_usdc_atomics || 0);
	const fee = BigInt(row.fee_usdc_atomics || 0);
	const sig = row.tx_signature;
	return {
		event_id: Number(row.id),
		action: row.meter_action,
		label: LABEL(row.meter_action),
		units: row.units,
		gross_atomics: gross.toString(),
		fee_atomics: fee.toString(),
		net_atomics: (gross - fee).toString(),
		gross_usd: atomicsToUsd(gross),
		fee_usd: atomicsToUsd(fee),
		discount_bps: row.discount_bps,
		discount_percent: row.discount_bps ? (row.discount_bps / 100).toFixed(1) : '0.0',
		settlement: {
			kind: row.settlement_kind,
			ref: row.settlement_ref,
			tx_signature: sig ?? null,
			network: row.network ?? null,
			explorer_url: sig ? `https://solscan.io/tx/${sig}` : null,
			token_price_usd: row.token_price_usd != null ? Number(row.token_price_usd) : null,
		},
		issued_at: row.created_at,
	};
}

/**
 * Reconciliation status for a user (or the whole platform when userId is null):
 * how many metered rows reconcile to a real settlement vs. how many are orphaned.
 * Surfaced on the revenue dashboard so an operator sees "all charges reconciled".
 *
 * A metered row reconciles when its settlement matches a real record:
 *   • settlement_kind='three' → a token_payments row with that id
 *   • settlement_kind='aws'   → an aws_marketplace_metering row with that allocation id
 *   • other kinds (x402/card) → treated as reconciled when a ref is present
 *
 * @returns {Promise<{ total:number, reconciled:number, unreconciled:number, by_kind:object }>}
 */
export async function reconciliationStatus({ userId = null } = {}) {
	const scope = userId ? sql`ue.user_id = ${userId}` : sql`true`;
	const [row] = await sql`
		select
			count(*)::int as total,
			count(*) filter (where
				(ue.settlement_kind = 'three' and exists (
					select 1 from token_payments tp where tp.id::text = ue.settlement_ref))
				or (ue.settlement_kind = 'aws' and exists (
					select 1 from aws_marketplace_metering am where am.usage_allocation_id = ue.settlement_ref))
				or (ue.settlement_kind not in ('three','aws') and ue.settlement_ref is not null)
			)::int as reconciled
		from usage_events ue
		where ue.kind = 'metered' and ${scope}
	`;
	const total = row?.total ?? 0;
	const reconciled = row?.reconciled ?? 0;
	return {
		total,
		reconciled,
		unreconciled: total - reconciled,
		all_reconciled: total === reconciled,
	};
}
