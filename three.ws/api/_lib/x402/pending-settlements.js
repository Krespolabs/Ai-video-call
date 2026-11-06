// api/_lib/x402/pending-settlements.js
//
// `settlement_pending`: the third settle outcome.
//
// An x402 settle used to answer success or failure and nothing else. That is a
// lie whenever a transaction has been broadcast and the confirmation wait runs
// out: the payment may have landed a slot later, and reporting failure charges
// the buyer while telling them they were not charged. The Solana x402
// facilitators adopted a third answer on 2026-09-17,
// `{ success: false, errorReason: 'settlement_pending', transaction }`, meaning
// "broadcast, outcome unknown, ask again rather than treating this as failed".
// The canonical SDKs retry it automatically instead of surfacing an error
// (`@x402/core`'s settleWithPendingRetry, `PendingSettlementStore`).
//
// This module is that contract on our own rail, backed by Postgres:
//
//   1. `SqlPendingSettlementStore` implements the x402 PendingSettlementStore
//      interface (get/set/delete) so the self-hosted facilitator can recognize a
//      retry of a payload it has ALREADY broadcast and re-await that signature
//      instead of signing and sending a second transaction. The SDK's default
//      store is a per-process Map, which only works when the retry happens to
//      land back on the same instance; our API runs several Cloud Run replicas
//      with no session affinity, so the store has to be shared. That is exactly
//      the case the interface is an interface for.
//
//   2. `recordPendingOrTerminal` is the decision the facilitator makes when a
//      confirmation wait fails: persist the signature and answer
//      `settlement_pending`, or (when the persist itself fails) answer a
//      terminal failure instead. Never answer pending without a record: a retry
//      with no record to reconcile against would re-verify and re-broadcast,
//      which is how an unknown outcome becomes a double-send.
//
//   3. `recordResourcePending` / `listOpenPendingSettlements` / `resolvePendingSettlement`
//      are the resource-server half. A pending settle still delivers the good
//      (the work is done and the payment is on the wire), so something has to
//      finish the accounting afterwards: /api/cron/x402-settlement-reconcile
//      confirms the signature, claims the settle credit exactly once, and meters
//      the SOL burn. The row is what makes that possible, which is why a pending
//      settle that cannot be recorded is downgraded to a hard failure.
//
// Every read and write here fails SOFT by design: a DB outage must never turn a
// payment that is already on chain into an exception in the settle path. Callers
// get `undefined`/`false` and decide (the facilitator downgrades pending to
// terminal; the resource server refuses to deliver on an unrecordable pending).

import { createHash } from 'node:crypto';

import { sql } from '../db.js';

// The wire value. Matches @x402/core's SETTLEMENT_PENDING_REASON exactly: an
// external buyer SDK keys its automatic retry on this string, so it is a
// protocol constant, not a label we are free to reword.
export const SETTLEMENT_PENDING_REASON = 'settlement_pending';

// Reason returned INSTEAD of pending when the store write fails. Terminal on
// purpose, and distinct from a plain confirm timeout so the signature it carries
// is recognizable in the log as one that needs manual reconciliation.
export const SETTLEMENT_PENDING_UNRECORDABLE_REASON = 'settlement_pending_unrecordable';

// How long a stored entry is treated as live. Past it, `get` reports absent, so
// a much later retry of the same payload is verified and broadcast afresh rather
// than reconciled against a signature whose blockhash expired long ago. Mirrors
// the SDK's in-memory TTL scale (minutes, not hours): a Solana blockhash is dead
// after ~60-90s, so a 10 minute window is already generous.
export const PENDING_SETTLEMENT_TTL_MS = 10 * 60_000;

export const PENDING_SCOPE_FACILITATOR = 'facilitator';
export const PENDING_SCOPE_RESOURCE = 'resource';

// Deterministic key for a payment payload: the same signed payload must produce
// the same key on every replica and every retry, and two different payments must
// never collide. The signed transaction bytes satisfy both (they carry the
// payer's signature over a single-use authorization), so hash them rather than
// reaching into the decoded shape.
export function pendingSettlementKey(txBase64) {
	if (!txBase64) return null;
	return createHash('sha256').update(String(txBase64), 'utf8').digest('hex');
}

function logFailure(op, err) {
	console.warn(`[x402-pending] ${op} failed: ${err?.message || err}`);
}

// The x402 PendingSettlementStore, over Postgres.
//
// `get` deliberately returns only rows still in the pending state and inside the
// TTL: a row the reconcile cron has already resolved must not send a fresh settle
// down the reconcile path, and an expired row must not either.
export class SqlPendingSettlementStore {
	constructor({ scope = PENDING_SCOPE_FACILITATOR, ttlMs = PENDING_SETTLEMENT_TTL_MS } = {}) {
		this.scope = scope;
		this.ttlMs = ttlMs;
	}

	async get(key) {
		if (!key) return undefined;
		const cutoff = new Date(Date.now() - this.ttlMs).toISOString();
		try {
			const rows = await sql`
				SELECT tx_sig
				FROM x402_pending_settlements
				WHERE scope = ${this.scope}
				  AND key = ${key}
				  AND state = 'pending'
				  AND created_at > ${cutoff}
				LIMIT 1
			`;
			return rows?.[0]?.tx_sig || undefined;
		} catch (err) {
			logFailure('get', err);
			return undefined;
		}
	}

	// Returns true only when the record is durable. The caller's answer to the
	// buyer depends on that, so a swallowed failure must still be visible.
	async set(key, txHash, meta = {}) {
		if (!key || !txHash) return false;
		try {
			await sql`
				INSERT INTO x402_pending_settlements
					(scope, key, tx_sig, network, payer, pay_to, mint, amount_atomic,
					 fee_lamports, fee_payer, resource_url, idempotency_key, state, last_error)
				VALUES
					(${this.scope}, ${key}, ${txHash}, ${meta.network || null}, ${meta.payer || null},
					 ${meta.payTo || null}, ${meta.mint || null}, ${meta.amountAtomic ?? null},
					 ${meta.feeLamports ?? null}, ${meta.feePayer || null}, ${meta.resourceUrl || null},
					 ${meta.idempotencyKey || null}, 'pending', ${meta.lastError || null})
				ON CONFLICT (scope, key) DO UPDATE SET
					tx_sig = EXCLUDED.tx_sig,
					state = 'pending',
					last_error = EXCLUDED.last_error,
					resolved_at = NULL,
					updated_at = now()
			`;
			return true;
		} catch (err) {
			logFailure('set', err);
			return false;
		}
	}

	async delete(key) {
		if (!key) return;
		try {
			await sql`
				DELETE FROM x402_pending_settlements
				WHERE scope = ${this.scope} AND key = ${key}
			`;
		} catch (err) {
			logFailure('delete', err);
		}
	}
}

// Persist `signature` under `key` and return the `settlement_pending` settle
// response, or (when the persist fails) a terminal failure carrying the same
// signature for manual reconciliation.
//
// The asymmetry is the whole point: answering pending promises a retry can
// reconcile, and without a record it cannot. Mirrors @x402/svm's
// recordPendingOrTerminal.
export async function recordPendingOrTerminal({
	store,
	key,
	signature,
	network,
	payer,
	meta = {},
	pendingReason = SETTLEMENT_PENDING_REASON,
	terminalReason = SETTLEMENT_PENDING_UNRECORDABLE_REASON,
	cause,
}) {
	const detail = cause ? String(cause?.message || cause).slice(0, 200) : '';
	const recorded = store
		? await store.set(key, signature, { ...meta, network, payer, lastError: detail })
		: false;
	if (!recorded) {
		return {
			success: false,
			reason: detail ? `${terminalReason}:${detail}` : terminalReason,
			transaction: signature,
			network,
			payer,
			pending: false,
		};
	}
	return {
		success: false,
		reason: pendingReason,
		transaction: signature,
		network,
		payer,
		pending: true,
		pendingDetail: detail || null,
	};
}

// Resource-server half: record a settle the facilitator answered `pending` so the
// reconcile cron can finish the accounting after the response is sent. Returns
// false when the row could not be written, which is the resource server's signal
// to refuse delivery rather than hand out a good it can never account for.
export async function recordResourcePending({ key, signature, meta = {} }) {
	const store = new SqlPendingSettlementStore({ scope: PENDING_SCOPE_RESOURCE });
	return store.set(key, signature, meta);
}

// Oldest-first page of rows still awaiting an answer. `minAgeMs` keeps the cron
// off signatures the settle path may still be waiting on itself.
export async function listOpenPendingSettlements({ limit = 100, minAgeMs = 5_000 } = {}) {
	const cutoff = new Date(Date.now() - minAgeMs).toISOString();
	const rows = await sql`
		SELECT scope, key, tx_sig, network, payer, pay_to, mint, amount_atomic,
		       fee_lamports, fee_payer, resource_url, idempotency_key, attempts,
		       created_at
		FROM x402_pending_settlements
		WHERE state = 'pending' AND created_at <= ${cutoff}
		ORDER BY created_at ASC
		LIMIT ${limit}
	`;
	return rows || [];
}

// Record the chain's answer. `state` is one of confirmed | failed | abandoned |
// pending; 'pending' only bumps the attempt counter (the chain still has not
// answered), every other value resolves the row.
export async function resolvePendingSettlement({ scope, key, state, error = null }) {
	const resolved = state !== 'pending';
	await sql`
		UPDATE x402_pending_settlements
		SET state = ${state},
		    attempts = attempts + 1,
		    last_error = ${error},
		    resolved_at = ${resolved ? new Date().toISOString() : null},
		    updated_at = now()
		WHERE scope = ${scope} AND key = ${key}
	`;
}

// Ops counters for /api/x402-status: how much of the rail is mid-flight, and how
// the recent history resolved. Cheap enough for a status probe (one grouped scan
// of a table that only holds live and recently-resolved settlements).
export async function pendingSettlementStats({ windowHours = 24 } = {}) {
	const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
	const rows = await sql`
		SELECT state, count(*)::int AS n
		FROM x402_pending_settlements
		WHERE created_at > ${since}
		GROUP BY state
	`;
	const out = { window_hours: windowHours, pending: 0, confirmed: 0, failed: 0, abandoned: 0 };
	for (const r of rows || []) {
		if (r.state in out) out[r.state] = r.n;
	}
	return out;
}
