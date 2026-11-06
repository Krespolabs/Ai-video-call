// Postgres-backed implementation of the @x402/extensions/sign-in-with-x
// SIWxStorage interface. Two tables back this adapter (see
// api/_lib/migrations/2026-05-21-siwx.sql):
//
//   siwx_payments(resource, address, network, paid_at, expires_at,
//                 last_used_at, use_count)
//     — one row per (resource, address). expires_at NULL = permanent grant
//       (downloadable assets); set to now()+TTL for time-pass access.
//
//   siwx_nonces(nonce, resource, address, used_at)
//     — replay-protection. Garbage-collected by api/cron/siwx-gc.js.
//
// Address normalization happens here, not at the DB layer: CAIP-122 carries
// addresses in their canonical-per-chain form, which differs by namespace:
//   eip155:*  → lowercase hex (NOT EIP-55 checksummed)
//   solana:*  → Base58 (case-sensitive, leave as-is)
//
// Every WRITE normalizes via normalizeAddress(network, address) — the network
// is known at recordPayment time. READS go through a chain-aware OR query
// because the SIWxStorage contract only passes (resource, address) to
// hasPaid: we lower-case the EVM branch and leave the Solana branch exact.

import { sql } from './db.js';

// Pull off the CAIP-2 namespace ('eip155' / 'solana' / etc.) without parsing
// the reference, so a future chain like 'eip155:42161' or 'solana:devnet'
// shares the same normalization branch.
function namespaceOf(chainId) {
	if (!chainId || typeof chainId !== 'string') return null;
	const colon = chainId.indexOf(':');
	return colon === -1 ? chainId.toLowerCase() : chainId.slice(0, colon).toLowerCase();
}

// Public — also used by siwx-server.js after verifying the signature.
export function normalizeAddress(chainId, address) {
	if (!chainId || !address) throw new Error('siwx-storage: network+address required');
	const ns = namespaceOf(chainId);
	if (ns === 'eip155') return String(address).toLowerCase();
	if (ns === 'solana') return String(address);
	throw new Error(`siwx-storage: unsupported CAIP-2 namespace "${chainId}"`);
}

async function hasPaid(resource, address) {
	if (!resource || !address) return false;
	const evm = String(address).toLowerCase();
	const sol = String(address);
	const rows = await sql`
		select expires_at, network
		  from siwx_payments
		 where resource = ${resource}
		   and (
		     (network like 'eip155:%' and address = ${evm})
		     or
		     (network like 'solana:%' and address = ${sol})
		   )
		 limit 1
	`;
	if (!rows.length) return false;
	const exp = rows[0].expires_at;
	if (exp && new Date(exp).getTime() <= Date.now()) return false;
	const matched = String(rows[0].network).startsWith('eip155:') ? evm : sol;
	await sql`
		update siwx_payments
		   set last_used_at = now(),
		       use_count    = use_count + 1
		 where resource = ${resource}
		   and address  = ${matched}
	`;
	return true;
}

async function recordPayment(resource, address, opts = {}) {
	if (!resource || !address) return;
	if (!opts.network) {
		throw new Error('siwx-storage.recordPayment: opts.network is required');
	}
	const normalized = normalizeAddress(opts.network, address);
	const ttlSeconds = Number.isFinite(opts.ttlSeconds) ? Number(opts.ttlSeconds) : null;
	const expiresAt =
		ttlSeconds && ttlSeconds > 0
			? new Date(Date.now() + ttlSeconds * 1000).toISOString()
			: null;
	await sql`
		insert into siwx_payments (resource, address, network, paid_at, expires_at)
		values (${resource}, ${normalized}, ${opts.network}, now(), ${expiresAt})
		on conflict (resource, address) do update
		   set network    = excluded.network,
		       paid_at    = excluded.paid_at,
		       expires_at = excluded.expires_at
	`;
}

async function hasUsedNonce(nonce) {
	if (!nonce) return false;
	const rows = await sql`select 1 from siwx_nonces where nonce = ${nonce} limit 1`;
	return rows.length > 0;
}

// Atomically claim a nonce. Returns true when this call inserted the row (the
// nonce was unused), false when it was already present (replay / lost race).
//
// The `RETURNING` on an `ON CONFLICT DO NOTHING` yields zero rows for the
// loser of a concurrent insert, so callers can gate access on the boolean and
// reject replays without a separate read — the SELECT-then-INSERT pattern has
// a race window (two requests both see "unused", both proceed) that this
// closes. `hasUsedNonce` stays as a cheap pre-check; this is the authority.
async function recordNonce(nonce, ctx = {}) {
	if (!nonce) return false;
	const rows = await sql`
		insert into siwx_nonces (nonce, resource, address, used_at)
		values (${nonce}, ${ctx.resource || ''}, ${ctx.address || ''}, now())
		on conflict (nonce) do nothing
		returning nonce
	`;
	return rows.length > 0;
}

// Cron helpers exported for api/cron/siwx-gc.js + tests. Both return the
// number of rows deleted so the cron can emit a sensible summary log.

// Compute the cutoff inside Postgres so the comparison uses the same clock
// as the now()-defaulted columns above — JS Date.now() can drift seconds
// from the Neon primary, and at the 0-grace boundary (cron-driven cleanup)
// the difference manifests as rows that should be deleted but aren't.

export async function pruneExpiredPayments(graceSeconds = 7 * 24 * 3600) {
	const rows = await sql`
		with deleted as (
			delete from siwx_payments
			 where expires_at is not null
			   and expires_at < now() - make_interval(secs => ${Number(graceSeconds)})
			 returning 1
		)
		select count(*)::int as n from deleted
	`;
	return rows[0]?.n ?? 0;
}

export async function pruneOldNonces(maxAgeSeconds = 600) {
	const rows = await sql`
		with deleted as (
			delete from siwx_nonces
			 where used_at < now() - make_interval(secs => ${Number(maxAgeSeconds)})
			 returning 1
		)
		select count(*)::int as n from deleted
	`;
	return rows[0]?.n ?? 0;
}

export const siwxStorage = {
	hasPaid,
	recordPayment,
	hasUsedNonce,
	recordNonce,
};
