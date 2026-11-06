-- Migration: three_allowances — the $THREE spend-allowance registry.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-06-21-three-allowances.sql
-- Idempotent.
--
-- SCALING: the allowance status/pull paths must never call getProgramAccounts —
-- it scans the whole program account set, is rate-limited on most RPCs, and is
-- O(program). Instead we persist each grant's deterministic delegation PDA here
-- when the user authorizes it, so reads become a cheap getMultipleAccountsInfo on
-- the user's own (few) PDAs, Redis-cached. This table is the index that makes the
-- allowance rail O(user) instead of O(program) under an influx of users.
--
-- No secrets: only public on-chain facts (PDA, nonce, cap, expiry, signatures) and
-- the owning user/wallet. `status` is the lifecycle the app reconciles against the
-- chain: pending → active → (spent | expired | revoked).

begin;

create table if not exists three_allowances (
    id                      uuid primary key default gen_random_uuid(),
    -- Nullable: a grant may originate from a wallet not linked to a user row.
    user_id                 uuid references users(id) on delete set null,
    wallet                  text not null,
    mint                    text not null,
    -- The platform delegate (delegatee) authorized at grant time. Pinned so a
    -- delegate-key rotation never silently reinterprets old grants.
    delegate                text not null,
    -- Deterministic PDA of this fixed delegation — the read key (UNIQUE).
    delegation_pda          text not null unique,
    subscription_authority  text not null,
    -- u64 nonce that seeds the delegation PDA.
    nonce                   numeric(20, 0) not null,
    -- Authorized cap and optional auto-expiry (unix seconds; 0 = no expiry).
    cap_atomics             numeric(40, 0) not null,
    expiry_ts               bigint not null default 0,
    network                 text not null default 'mainnet',
    -- Lifecycle: pending (built, not yet confirmed on-chain) → active → terminal.
    status                  text not null default 'pending'
                            check (status in ('pending', 'active', 'revoked', 'spent', 'expired')),
    grant_tx                text,
    revoke_tx               text,
    -- Last reconciled remaining balance + when (drives the UI without a fresh RPC).
    last_remaining_atomics  numeric(40, 0),
    last_synced_at          timestamptz,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

-- Hot path: list a wallet's live allowances (status-filtered, newest first).
create index if not exists three_allowances_wallet_status
    on three_allowances (wallet, status, created_at desc);

create index if not exists three_allowances_user
    on three_allowances (user_id, created_at desc);

commit;
