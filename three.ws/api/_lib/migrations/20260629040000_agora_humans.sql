-- Agora — humans as first-class citizens (Task 08, see docs/agora.md § Citizens).
--
-- A human citizen is a signed-in user (agora_citizens.kind='human', user_id set,
-- agent_id null). Humans don't run the autonomous loop — they act through the
-- /agora UI, and every action performs the SAME real on-chain AgenC operation an
-- agent would, projected into the same agora_activity ledger. There is never a
-- separate "fake human" path.
--
-- To transact on AgenC server-side (post/escrow, claim, complete, register) the
-- human citizen gets a CUSTODIAL Solana wallet, provisioned on join exactly like
-- an agent's (api/_lib/agent-wallet.js generateSolanaAgentWallet → AES-256-GCM
-- encrypted secret). The address + ciphertext live in agora_citizens.meta
-- (jsonb) — no schema change needed there — and the secret never leaves the
-- server. The server signs on the human's behalf, gated by auth + a per-user
-- spend policy (api/_lib/agora-policy.js).
--
-- This migration adds the two tables Task 08 needs on top of the world layer:
--   • agora_vouches      — the attestation graph (one real on-chain vouch per
--                          (voucher, subject), deduped + rate-limited).
--   • agora_idempotency  — durable idempotency for mutating /api/agora/act calls
--                          so a retried POST never double-escrows or double-vouches
--                          across serverless invocations.

-- ── Vouches (the trust graph) ─────────────────────────────────────────────────
-- A vouch is a human citizen attesting, on-chain, that another citizen did good
-- work. It cites the tx_signature of the attestation and is deduped per ordered
-- pair so a single relationship is one edge, refreshable but never spammed. The
-- projection mirror in agora_activity (kind='vouched') drives the feed + passport;
-- this table is the queryable graph (who vouched for whom, when, how strongly).
create table if not exists agora_vouches (
    id              uuid primary key default gen_random_uuid(),
    -- The human (or agent) doing the vouching, and the citizen being vouched for.
    voucher_citizen_id uuid not null references agora_citizens(id) on delete cascade,
    subject_citizen_id uuid not null references agora_citizens(id) on delete cascade,
    -- The user behind the voucher, captured for per-user rate-limiting even if the
    -- citizen row is later repointed.
    voucher_user_id text,
    -- The task whose verified deliverable prompted the vouch (Task 07 Verify), if any.
    task_pda        text,
    -- Weight of the attestation (1 = standard vouch). Reserved for future
    -- reputation-graph weighting; always >= 1.
    weight          integer not null default 1 check (weight >= 1),
    -- The on-chain attestation this vouch cites. memo-tx signature on the cluster.
    tx_signature    text,
    cluster         text not null default 'devnet'
                        check (cluster in ('devnet', 'mainnet')),
    note            text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    meta            jsonb not null default '{}'::jsonb,
    -- A citizen cannot vouch for itself.
    constraint agora_vouches_not_self check (voucher_citizen_id <> subject_citizen_id)
);

-- One edge per ordered (voucher, subject): a repeat vouch updates the existing
-- edge (refresh tx + note) rather than stacking duplicates.
create unique index if not exists agora_vouches_edge_uniq
    on agora_vouches(voucher_citizen_id, subject_citizen_id);
create index if not exists agora_vouches_subject
    on agora_vouches(subject_citizen_id, created_at desc);
create index if not exists agora_vouches_voucher_time
    on agora_vouches(voucher_user_id, created_at desc);

-- ── Idempotency (durable, cross-invocation) ───────────────────────────────────
-- Mutating /api/agora/act calls may carry an Idempotency-Key header. The first
-- request for a (user, action, key) inserts a pending row under the unique index;
-- a concurrent or retried request finds it and returns the stored response
-- instead of re-running an on-chain escrow/claim/complete. Rows expire so the
-- table stays small; a sweep (or a TTL job) prunes past expires_at.
create table if not exists agora_idempotency (
    id            uuid primary key default gen_random_uuid(),
    user_id       text not null,
    action        text not null,
    idem_key      text not null,
    -- 'pending' while the action runs; 'done' once the response is captured.
    status        text not null default 'pending'
                      check (status in ('pending', 'done')),
    -- The captured JSON response body to replay on a duplicate request.
    response      jsonb,
    -- Hash of the request body, so a replay with the SAME key but a DIFFERENT
    -- payload is rejected (409) rather than silently returning the old result.
    request_hash  text,
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null default now() + interval '24 hours'
);

create unique index if not exists agora_idempotency_key_uniq
    on agora_idempotency(user_id, action, idem_key);
create index if not exists agora_idempotency_expiry
    on agora_idempotency(expires_at);
