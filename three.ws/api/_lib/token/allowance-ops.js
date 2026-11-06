// $THREE allowance — chain operations (read status, build grant/revoke, pull).
//
// SCALING MODEL: never getProgramAccounts on the hot path. Grants are persisted in
// three_allowances (allowance-registry.js) with their deterministic PDAs, so a
// status read is a single batched getMultipleAccountsInfo over the user's own few
// PDAs, served from a short-TTL Redis cache. getProgramAccounts survives only as a
// one-shot fallback for a wallet with zero registry rows (a grant made before this
// index existed, or from another client) — bounded and rare.
//
// Pure encodings live in ./allowance.js (unit-tested). This module is the thin
// RPC/signing/cache shell.

import { PublicKey, Transaction } from '@solana/web3.js';
import {
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_2022_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { solanaConnection } from '../solana/connection.js';
import { pollConfirmation } from '../solana/confirm.js';
import { getRedis } from '../redis.js';
import { TOKEN_MINT, ATOMICS_PER_TOKEN } from './config.js';
import {
	SUBSCRIPTIONS_PROGRAM_ID,
	subscriptionAuthorityPda,
	fixedDelegationPda,
	userThreeAta,
	ixInitSubscriptionAuthority,
	ixCreateFixedDelegation,
	ixRevokeDelegation,
	ixTransferFixed,
	parseSubscriptionAuthorityInitId,
	parseFixedDelegation,
	loadDelegateKeypair,
	delegateAddress,
} from './allowance.js';
import {
	recordPendingGrant,
	markGrantActive,
	markRevoked,
	getAllowanceRow,
	listWalletAllowances,
	syncReconciled,
} from './allowance-registry.js';

const mintPubkey = () => new PublicKey(TOKEN_MINT);
const nowSec = () => Math.floor(Date.now() / 1000);
const STATUS_CACHE_TTL_S = 15;

function conn(network = 'mainnet') {
	return solanaConnection({ network });
}

function statusCacheKey(wallet, network) {
	return `three-allow:status:${network}:${wallet}`;
}

/** Drop the cached status so the next read reflects a just-landed grant/revoke/pull. */
export async function invalidateAllowanceStatus(wallet, network = 'mainnet') {
	const redis = getRedis();
	if (redis) await redis.del(statusCacheKey(wallet, network)).catch(() => {});
}

/** A delegation is spendable when it has remaining balance and is not past expiry (0 = none). */
function isLive(remaining, expiryTs, now = nowSec()) {
	return remaining > 0n && (expiryTs <= 0 || expiryTs > now);
}

/**
 * Reconcile the user's registry rows against the chain in ONE batched RPC, write
 * back the observed state, and return the live delegations. This is the cheap
 * path that replaces getProgramAccounts. Returns null when the wallet has no
 * registry rows (caller may then fall back).
 */
async function reconcileFromRegistry(connection, wallet, network) {
	const rows = await listWalletAllowances({ wallet, network });
	if (!rows.length) return null;

	const pdas = rows.map((r) => new PublicKey(r.delegation_pda));
	const infos = await connection.getMultipleAccountsInfo(pdas, 'confirmed');
	const now = nowSec();
	const live = [];

	await Promise.all(
		rows.map(async (row, i) => {
			const info = infos[i];
			if (!info) {
				// Account gone: a still-pending grant never landed, or an active one
				// was fully spent/closed. Mark terminal so it stops being re-read.
				if (row.status === 'active') await syncReconciled({ delegationPda: row.delegation_pda, remainingAtomics: 0, status: 'spent' });
				return;
			}
			const parsed = parseFixedDelegation(info.data);
			if (!parsed) return;
			// First on-chain sighting of a pending grant ⇒ it's active.
			const nextStatus = parsed.remaining === 0n ? 'spent' : 'active';
			// Skip the write when nothing observable changed — under load the 15s cache
			// means each active user reconciles at most ~4×/min; this trims those to
			// only the reconciles that actually move the balance or lifecycle.
			const changed = row.status !== nextStatus || row.last_remaining_atomics !== parsed.remaining.toString();
			if (changed) {
				if (row.status === 'pending' && nextStatus !== 'pending') await markGrantActive({ delegationPda: row.delegation_pda });
				await syncReconciled({ delegationPda: row.delegation_pda, remainingAtomics: parsed.remaining.toString(), status: nextStatus });
			}
			if (isLive(parsed.remaining, parsed.expiryTs, now)) {
				live.push({ pubkey: row.delegation_pda, remaining: parsed.remaining, expiryTs: parsed.expiryTs });
			}
		}),
	);

	live.sort((a, b) => (b.remaining > a.remaining ? 1 : b.remaining < a.remaining ? -1 : 0));
	return live;
}

/** Bounded fallback: discover delegations on-chain for a wallet with no registry rows. */
async function discoverFromChain(connection, wallet, delegate) {
	const accounts = await connection.getProgramAccounts(SUBSCRIPTIONS_PROGRAM_ID, {
		filters: [
			{ dataSize: 187 },
			{ memcmp: { offset: 3, bytes: new PublicKey(wallet).toBase58() } },
			{ memcmp: { offset: 35, bytes: delegate } },
		],
	});
	const now = nowSec();
	return accounts
		.map(({ pubkey, account }) => {
			const parsed = parseFixedDelegation(account.data);
			return parsed ? { pubkey: pubkey.toBase58(), remaining: parsed.remaining, expiryTs: parsed.expiryTs } : null;
		})
		.filter((d) => d && isLive(d.remaining, d.expiryTs, now))
		.sort((a, b) => (b.remaining > a.remaining ? 1 : b.remaining < a.remaining ? -1 : 0));
}

function shapeStatus(delegate, wallet, live) {
	const totalRemaining = live.reduce((s, d) => s + d.remaining, 0n);
	return {
		enabled: true,
		delegate,
		wallet,
		remaining_atomics: totalRemaining.toString(),
		remaining_tokens: Number(totalRemaining) / Number(ATOMICS_PER_TOKEN),
		delegations: live.map((d) => ({
			pubkey: d.pubkey,
			remaining_atomics: d.remaining.toString(),
			remaining_tokens: Number(d.remaining) / Number(ATOMICS_PER_TOKEN),
			expiry_ts: d.expiryTs,
		})),
	};
}

/**
 * The user's live $THREE spend allowance. Redis-cached (TTL 15s) and DB-indexed;
 * `fresh: true` bypasses the cache (used by the pull path before moving funds).
 */
export async function getAllowanceStatus(userWallet, { network = 'mainnet', fresh = false } = {}) {
	const delegate = await delegateAddress();
	if (!delegate) return { enabled: false, delegate: null, wallet: userWallet, remaining_atomics: '0', delegations: [] };

	const redis = getRedis();
	const cacheKey = statusCacheKey(userWallet, network);
	if (!fresh && redis) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) return cached;
		} catch { /* fall through to a live read */ }
	}

	const connection = conn(network);
	let live;
	try {
		live = await reconcileFromRegistry(connection, userWallet, network);
		if (live == null) live = await discoverFromChain(connection, userWallet, delegate);
	} catch (err) {
		// Read path never throws — degrade to "no allowance" and let the caller fall
		// back to the signed quote flow. Don't cache a degraded result.
		console.warn('[allowance] status read failed:', err?.message || err);
		return { enabled: true, delegate, wallet: userWallet, remaining_atomics: '0', delegations: [], degraded: true };
	}

	const result = shapeStatus(delegate, userWallet, live);
	if (redis) redis.set(cacheKey, result, { ex: STATUS_CACHE_TTL_S }).catch(() => {});
	return result;
}

/**
 * Build the user-signed GRANT transaction and persist it as a pending registry row
 * so the status/pull paths can read it cheaply. Returns the unsigned tx (base64),
 * the delegation PDA, and the nonce.
 */
export async function buildGrantTransaction({ userWallet, capAtomics, expiryTs = 0, network = 'mainnet', userId = null }) {
	const delegate = await delegateAddress();
	if (!delegate) {
		throw Object.assign(new Error('allowance delegate not configured'), { status: 503, code: 'allowance_unavailable' });
	}

	const owner = new PublicKey(userWallet);
	const mint = mintPubkey();
	const sa = subscriptionAuthorityPda(owner, mint);
	const connection = conn(network);

	const instructions = [];
	let expectedInitId;
	const saInfo = await connection.getAccountInfo(sa, 'confirmed');
	if (!saInfo) {
		instructions.push(ixInitSubscriptionAuthority({ owner, mint }));
		expectedInitId = nowSec(); // fresh SA: program stamps clock; within drift tolerance
	} else {
		expectedInitId = parseSubscriptionAuthorityInitId(saInfo.data);
		if (expectedInitId == null) {
			throw Object.assign(new Error('unreadable subscription authority'), { status: 422, code: 'sa_unreadable' });
		}
	}

	const nonce = nowSec();
	const delegatePk = new PublicKey(delegate);
	instructions.push(
		ixCreateFixedDelegation({
			delegator: owner,
			delegatee: delegatePk,
			nonce,
			amount: BigInt(capAtomics),
			expiryTs: Math.floor(expiryTs) || 0,
			expectedInitId,
			mint,
		}),
	);

	const { blockhash } = await connection.getLatestBlockhash('confirmed');
	const tx = new Transaction();
	tx.add(...instructions);
	tx.feePayer = owner;
	tx.recentBlockhash = blockhash;

	const delegationPda = fixedDelegationPda({ subscriptionAuthority: sa, delegator: owner, delegatee: delegatePk, nonce });

	// Persist intent before the user signs, so confirm + status can find it. A
	// never-sent grant simply stays 'pending' and is reconciled away on next read.
	await recordPendingGrant({
		userId,
		wallet: userWallet,
		mint: TOKEN_MINT,
		delegate,
		delegationPda: delegationPda.toBase58(),
		subscriptionAuthority: sa.toBase58(),
		nonce,
		capAtomics: BigInt(capAtomics).toString(),
		expiryTs: Math.floor(expiryTs) || 0,
		network,
	}).catch((err) => console.warn('[allowance] recordPendingGrant failed (non-fatal):', err?.message || err));

	return {
		transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
		delegation_pda: delegationPda.toBase58(),
		nonce,
		recent_blockhash: blockhash,
	};
}

/**
 * Reconcile a single delegation PDA after a signed grant or revoke landed, and
 * update the registry. `revoked: true` marks it revoked once the account is gone.
 * Returns the new lifecycle state + remaining for an instant, accurate UI update.
 */
export async function confirmAllowance({ userWallet, delegationPda, revoked = false, network = 'mainnet' }) {
	// Ownership guard: a registry row must belong to the caller before we mutate it,
	// so one user can never flip another user's allowance state in our index. A
	// legacy/external grant with no row is validated against the on-chain delegator
	// below instead.
	const row = await getAllowanceRow(delegationPda);
	if (row && row.wallet !== userWallet) {
		throw Object.assign(new Error('not your allowance'), { status: 403, code: 'forbidden' });
	}

	const connection = conn(network);
	const info = await connection.getAccountInfo(new PublicKey(delegationPda), 'confirmed');

	if (!info) {
		// Only a known-owned row may be marked terminal on a missing account; without
		// a row we can't prove ownership of a vanished account, so we no-op.
		if (row) {
			if (revoked) await markRevoked({ delegationPda });
			else await syncReconciled({ delegationPda, remainingAtomics: 0, status: 'spent' });
			await invalidateAllowanceStatus(userWallet, network);
		}
		return { active: false, status: revoked ? 'revoked' : 'spent', remaining_atomics: '0' };
	}

	const parsed = parseFixedDelegation(info.data);
	// For an external grant (no row), bind the confirm to the on-chain delegator.
	if (!row && parsed && parsed.delegator !== userWallet) {
		throw Object.assign(new Error('not your allowance'), { status: 403, code: 'forbidden' });
	}
	const remaining = parsed?.remaining ?? 0n;
	const status = remaining === 0n ? 'spent' : 'active';
	if (status === 'active') await markGrantActive({ delegationPda });
	await syncReconciled({ delegationPda, remainingAtomics: remaining.toString(), status });
	await invalidateAllowanceStatus(userWallet, network);
	return { active: status === 'active', status, remaining_atomics: remaining.toString() };
}

/**
 * Build the user-signed REVOKE transaction for one of their delegations. Ownership
 * is checked against the registry (the wallet must own the row) so a user can only
 * revoke their own grant.
 */
export async function buildRevokeTransaction({ userWallet, delegationPda, network = 'mainnet' }) {
	const row = await getAllowanceRow(delegationPda);
	if (row && row.wallet !== userWallet) {
		throw Object.assign(new Error('not your allowance'), { status: 403, code: 'forbidden' });
	}

	const owner = new PublicKey(userWallet);
	const connection = conn(network);
	const tx = new Transaction();
	tx.add(ixRevokeDelegation({ authority: owner, delegationPda }));
	const { blockhash } = await connection.getLatestBlockhash('confirmed');
	tx.feePayer = owner;
	tx.recentBlockhash = blockhash;

	return {
		transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
		delegation_pda: delegationPda,
		recent_blockhash: blockhash,
	};
}

/**
 * Pull `legs` from the user's wallet against an existing allowance in a single
 * delegate-signed transaction — no user popup. Reads candidates FRESH (bypassing
 * the status cache) so it never moves funds on a stale balance.
 *
 * Throws 'insufficient_allowance' when no single live delegation covers the total
 * — the caller treats that as "fall back to the signed quote flow".
 */
export async function pullFromAllowance({ userWallet, legs, network = 'mainnet' }) {
	const delegate = await loadDelegateKeypair();
	if (!delegate) {
		throw Object.assign(new Error('allowance delegate not configured'), { status: 503, code: 'allowance_unavailable' });
	}

	const total = legs.reduce((s, l) => s + BigInt(l.atomics), 0n);
	if (total <= 0n) throw Object.assign(new Error('nothing to charge'), { status: 400, code: 'zero_charge' });

	const status = await getAllowanceStatus(userWallet, { network, fresh: true });
	const covering = status.delegations.find((d) => BigInt(d.remaining_atomics) >= total);
	if (!covering) {
		throw Object.assign(new Error('no active allowance covers this charge'), {
			status: 402,
			code: 'insufficient_allowance',
			remaining_atomics: status.remaining_atomics,
		});
	}

	const owner = new PublicKey(userWallet);
	const mint = mintPubkey();
	const connection = conn(network);
	const tx = new Transaction();

	for (const leg of legs) {
		const receiver = new PublicKey(leg.address);
		tx.add(
			createAssociatedTokenAccountIdempotentInstruction(
				delegate.publicKey,
				userThreeAta(receiver, mint),
				receiver,
				mint,
				TOKEN_2022_PROGRAM_ID,
				ASSOCIATED_TOKEN_PROGRAM_ID,
			),
		);
		tx.add(
			ixTransferFixed({
				delegationPda: covering.pubkey,
				delegator: owner,
				delegatee: delegate.publicKey,
				receiver,
				amount: BigInt(leg.atomics),
				mint,
			}),
		);
	}

	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	tx.feePayer = delegate.publicKey;
	tx.recentBlockhash = blockhash;
	tx.sign(delegate);

	const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
	// HTTP-polling confirm (no WebSocket) — keeps the RPC failover in play and maps a
	// landed-but-reverted pull to the caller's `pull_failed` contract below.
	const confirmation = await pollConfirmation(
		connection,
		{ signature, blockhash, lastValidBlockHeight },
		'confirmed',
	);
	if (confirmation.value?.err) {
		throw Object.assign(new Error('allowance pull failed on-chain'), {
			status: 502,
			code: 'pull_failed',
			detail: confirmation.value.err,
		});
	}

	// Reflect the spend immediately: decrement the cached/registry remaining and
	// drop the status cache so the next read is accurate.
	const remainingAfter = BigInt(covering.remaining_atomics) - total;
	await syncReconciled({
		delegationPda: covering.pubkey,
		remainingAtomics: remainingAfter.toString(),
		status: remainingAfter === 0n ? 'spent' : 'active',
	}).catch(() => {});
	await invalidateAllowanceStatus(userWallet, network);

	return {
		signature,
		delegation_pda: covering.pubkey,
		total_atomics: total.toString(),
		remaining_after_atomics: remainingAfter.toString(),
		slot: confirmation.context?.slot ?? null,
	};
}
