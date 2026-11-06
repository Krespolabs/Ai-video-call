// @ts-check
// GET /api/cron/x402-settlement-reconcile: closes the books on every x402
// settlement that answered `settlement_pending`.
//
// A pending settle is a payment whose transaction is broadcast and whose outcome
// was still unknown when the buyer's request had to return. The rail answers
// `{ success:false, errorReason:'settlement_pending', transaction }` instead of a
// failure the buyer's own wallet history contradicts, delivers the good, and
// records the signature (api/_lib/x402/pending-settlements.js). That leaves
// exactly one job outstanding: ask the chain what happened and finish the
// accounting. This cron is that job.
//
// Per open row, every 2 minutes:
//   1. probeSettlementSignature(): read-only signature status, searching
//      transaction history so a settlement that landed minutes ago is still
//      found. It never signs and never re-broadcasts; re-sending a transaction
//      whose fate is unknown is the double-charge this whole mechanism exists to
//      avoid.
//   2. confirmed → claimSettleCredit() under the SAME idempotency key the settle
//      used, so the credit is granted at most once per signature (settle-credit.js
//      is the atomic arbiter) and the real network fee lands in the fee book.
//   3. failed / abandoned → resolve the row and alert. A resource-scope row in
//      either state means a good was delivered against a payment that never
//      settled, which is the one loss this design can produce and must therefore
//      never be silent.
//   4. still unknown → bump the attempt counter and look again next pass.
//
// Rows are keyed (scope, key) and resolved idempotently, so a run that overlaps
// the previous one cannot double-credit: the credit gate, not this loop, is what
// enforces "one signature settles at most one payment".

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { requireCron } from '../_lib/cron-auth.js';
import { env } from '../_lib/env.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { claimSettleCredit } from '../_lib/x402/settle-credit.js';
import { promotePendingSettlementStatus } from '../_lib/x402/audit-log.js';
import { probeSettlementSignature } from '../_lib/x402/self-facilitator.js';
import {
	PENDING_SCOPE_RESOURCE,
	listOpenPendingSettlements,
	resolvePendingSettlement,
} from '../_lib/x402/pending-settlements.js';

// Rows per run. A pending settlement is rare by construction (the settle path
// waits out the common case inline), so this is a generous ceiling that also
// bounds RPC spend if a provider incident produces a burst of them.
const MAX_ROWS_PER_RUN = 100;
// Leave a settle that may still be inside its own confirmation window alone: the
// request that created the row can still resolve it itself.
const MIN_AGE_MS = 20_000;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const rows = await listOpenPendingSettlements({
		limit: MAX_ROWS_PER_RUN,
		minAgeMs: MIN_AGE_MS,
	});

	if (rows.length === 0) {
		return json(res, 200, { ok: true, scanned: 0, confirmed: 0, failed: 0, abandoned: 0, still_pending: 0 });
	}

	const conn = solanaConnection({
		url: env.SOLANA_RPC_URL,
		network: 'mainnet',
		commitment: 'confirmed',
	});

	const counts = { confirmed: 0, failed: 0, abandoned: 0, still_pending: 0, credited: 0 };
	const unsettledDeliveries = [];
	const results = [];

	for (const row of rows) {
		const broadcastAtMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
		let probe;
		try {
			probe = await probeSettlementSignature({
				conn,
				signature: row.tx_sig,
				broadcastAtMs,
			});
		} catch (err) {
			// A probe fault is not an answer. Leave the row open.
			probe = { state: 'pending', error: `probe_failed:${String(err?.message || err).slice(0, 160)}` };
		}

		if (probe.state === 'confirmed') {
			// The fee the chain actually charged, when the parsed transaction was
			// readable; otherwise the estimate recorded at broadcast. Either way the
			// credit row is what the daily fee book sums, so it must carry a number.
			const feeLamports = probe.feeLamports ?? row.fee_lamports ?? null;
			const credit = await claimSettleCredit({
				sql,
				row: {
					network: row.network,
					payer: row.payer,
					payTo: row.pay_to,
					mint: row.mint,
					amountAtomic: row.amount_atomic == null ? null : Number(row.amount_atomic),
					txSig: row.tx_sig,
					feeLamports,
					idempotencyKey: row.idempotency_key,
					feePayer: row.fee_payer,
				},
			});
			if (credit.granted) counts.credited += 1;
			// The audit row was written with settlement_status='pending' while the
			// outcome was unknown, and every revenue query counts 'success'. Promote
			// it now, or this payment never reaches the books.
			await promotePendingSettlementStatus({ txHash: row.tx_sig, status: 'success' });
			// A refused claim that is NOT an idempotent replay means another payment
			// already owns this signature, or the DB could not answer. Neither is a
			// reason to keep re-probing a transaction the chain has already confirmed,
			// so the row resolves and carries the refusal for the audit trail.
			await resolvePendingSettlement({
				scope: row.scope,
				key: row.key,
				state: 'confirmed',
				error: credit.granted ? null : credit.reason || null,
			});
			counts.confirmed += 1;
			results.push({ sig: row.tx_sig, state: 'confirmed', credit: credit.granted ? 'granted' : credit.reason });
			continue;
		}

		if (probe.state === 'failed' || probe.state === 'abandoned') {
			await resolvePendingSettlement({
				scope: row.scope,
				key: row.key,
				state: probe.state,
				error: probe.error || null,
			});
			await promotePendingSettlementStatus({ txHash: row.tx_sig, status: 'failed' });
			counts[probe.state] += 1;
			results.push({ sig: row.tx_sig, state: probe.state, error: probe.error || null });
			// Resource scope = the buyer already has the good. That is the deliberate
			// trade the pending state makes, and the only case where it costs us.
			if (row.scope === PENDING_SCOPE_RESOURCE) {
				unsettledDeliveries.push({
					sig: row.tx_sig,
					state: probe.state,
					resource: row.resource_url,
					payer: row.payer,
					amount_atomic: row.amount_atomic,
				});
			}
			continue;
		}

		await resolvePendingSettlement({
			scope: row.scope,
			key: row.key,
			state: 'pending',
			error: probe.error || null,
		});
		counts.still_pending += 1;
		results.push({ sig: row.tx_sig, state: 'pending', error: probe.error || null });
	}

	if (unsettledDeliveries.length > 0) {
		const lines = unsettledDeliveries
			.map(
				(d) =>
					`• ${d.state}: ${d.sig} (${d.resource || 'unknown resource'}, payer ${d.payer || 'unknown'}, ${d.amount_atomic ?? '?'} atomic)`,
			)
			.join('\n');
		await sendOpsAlert(
			`x402: ${unsettledDeliveries.length} delivered payment${unsettledDeliveries.length === 1 ? '' : 's'} never settled`,
			`A pending settlement resolved as failed or abandoned AFTER the good was delivered. ` +
				`The buyer has the response and the transfer did not land.\n\n${lines}\n\n` +
				`Check the sponsor wallet's SOL and the RPC health for the window above: a burst here means ` +
				`settlements are being broadcast into conditions where they cannot confirm.`,
			{ signature: `x402-unsettled-delivery:${unsettledDeliveries[0].sig}` },
		);
	}

	return json(res, 200, {
		ok: true,
		scanned: rows.length,
		...counts,
		results,
	});
});
