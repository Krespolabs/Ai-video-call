-- Migration: token-gated 3D embeds — server-verified on-chain SPL-token-balance
-- gating for interactive <three-d> embeds (see api/_lib/embed-gate.js,
-- api/embed/gate-create.js, api/embed/gate-verify.js, api/embed/resolve.js).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260708120000_embed_gates.sql
-- Idempotent.
--
-- One row per active gate, keyed by the SAME embed asset ref the resolver in
-- api/_lib/embed-asset.js already understands ("avatar:<uuid>" or
-- "<chainId>:<agentId>"). At most one active (non-revoked) gate per asset — a
-- creator changing the requirement revokes the old row and inserts a new one,
-- which also invalidates every access token minted against the old gate id.
--
-- embed_gate_nonces mirrors gate_nonces (scene_gates' nonce table) but scoped
-- to embed_gates so the two gating systems (chat scenes vs. embeds) never share
-- state, even though the verification flow (SIWS challenge → nonce → signature
-- → on-chain balance) is the same shape.

begin;

create table if not exists embed_gates (
    id             text primary key,                 -- short opaque gate id
    asset_id       text not null,                     -- "avatar:<uuid>" | "<chainId>:<agentId>"
    owner_user_id  uuid references users(id) on delete set null,
    chain          text not null default 'solana' check (chain in ('solana')),
    mint           text not null,                     -- SPL mint; defaults to $THREE at the call site
    min_amount     numeric not null check (min_amount > 0),
    revoked_at     timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

-- At most one active gate per asset — resolve.js and gate-verify.js both look
-- this up by asset_id alone and need a deterministic single row.
create unique index if not exists embed_gates_asset_active_uniq
    on embed_gates(asset_id) where revoked_at is null;

create index if not exists embed_gates_owner on embed_gates(owner_user_id);

create table if not exists embed_gate_nonces (
    nonce       text primary key,
    gate_id     text not null references embed_gates(id) on delete cascade,
    address     text not null,
    expires_at  timestamptz not null,
    consumed_at timestamptz
);

create index if not exists embed_gate_nonces_expiry  on embed_gate_nonces(expires_at);
create index if not exists embed_gate_nonces_gate_id on embed_gate_nonces(gate_id);

commit;
