// $THREE allowance registry — the DB index that keeps the rail O(user), not
// O(program). Every grant we build is persisted with its deterministic delegation
// PDA, so status/pull paths read the user's own few PDAs via a batched
// getMultipleAccountsInfo (cheap, cacheable) instead of getProgramAccounts (a
// whole-program scan that public RPCs throttle or disable). This module is the
// thin persistence layer; reconciliation against the chain lives in allowance-ops.

import { sql } from '../db.js';

/**
 * Record a freshly-built grant as `pending` (the user hasn't signed/sent yet).
 * Keyed by the delegation PDA. A retried build of the same PDA refreshes the
 * intended cap/expiry rather than duplicating.
 */
export async function recordPendingGrant({
	userId = null,
	wallet,
	mint,
	delegate,
	delegationPda,
	subscriptionAuthority,
	nonce,
	capAtomics,
	expiryTs = 0,
	network = 'mainnet',
}) {
	const [row] = await sql`
		insert into three_allowances
			(user_id, wallet, mint, delegate, delegation_pda, subscription_authority,
			 nonce, cap_atomics, expiry_ts, network, status)
		values
			(${userId}, ${wallet}, ${mint}, ${delegate}, ${delegationPda}, ${subscriptionAuthority},
			 ${String(nonce)}, ${String(capAtomics)}, ${expiryTs}, ${network}, 'pending')
		on conflict (delegation_pda) do update
			set cap_atomics = excluded.cap_atomics,
			    expiry_ts   = excluded.expiry_ts,
			    user_id     = coalesce(three_allowances.user_id, excluded.user_id),
			    updated_at  = now()
		returning id
	`;
	return row?.id ?? null;
}

/** Promote a grant to `active` once its signed transaction is confirmed on-chain. */
export async function markGrantActive({ delegationPda, grantTx = null }) {
	const [row] = await sql`
		update three_allowances
		   set status = 'active', grant_tx = coalesce(${grantTx}, grant_tx), updated_at = now()
		 where delegation_pda = ${delegationPda}
		   and status in ('pending', 'active')
		returning id, wallet, network
	`;
	return row ?? null;
}

/** Mark a grant revoked (the on-chain account is closed; rent returned to the user). */
export async function markRevoked({ delegationPda, revokeTx = null }) {
	const [row] = await sql`
		update three_allowances
		   set status = 'revoked', revoke_tx = coalesce(${revokeTx}, revoke_tx),
		       last_remaining_atomics = 0, last_synced_at = now(), updated_at = now()
		 where delegation_pda = ${delegationPda}
		returning id, wallet, network
	`;
	return row ?? null;
}

/** A single allowance row (used to authorize a revoke against its owner). */
export async function getAllowanceRow(delegationPda) {
	const [row] = await sql`
		select id, user_id, wallet, mint, delegate, delegation_pda, subscription_authority,
		       nonce::text as nonce, cap_atomics::text as cap_atomics, expiry_ts, network, status
		  from three_allowances
		 where delegation_pda = ${delegationPda}
		 limit 1
	`;
	return row ?? null;
}

/**
 * A wallet's allowances in the given lifecycle states (default: live ones).
 * Newest first. The hot read for status + pull candidate selection.
 */
export async function listWalletAllowances({ wallet, network = 'mainnet', statuses = ['pending', 'active'] }) {
	const rows = await sql`
		select id, delegation_pda, subscription_authority, nonce::text as nonce,
		       cap_atomics::text as cap_atomics, expiry_ts, status,
		       last_remaining_atomics::text as last_remaining_atomics
		  from three_allowances
		 where wallet = ${wallet}
		   and network = ${network}
		   and status = any(${statuses})
		 order by created_at desc
		 limit 50
	`;
	return rows;
}

/**
 * Write back the reconciled on-chain state (remaining balance + lifecycle) after a
 * chain read, so the next render can trust the DB without another RPC.
 */
export async function syncReconciled({ delegationPda, remainingAtomics, status }) {
	await sql`
		update three_allowances
		   set last_remaining_atomics = ${remainingAtomics == null ? null : String(remainingAtomics)},
		       status = coalesce(${status}, status),
		       last_synced_at = now(), updated_at = now()
		 where delegation_pda = ${delegationPda}
	`;
}
