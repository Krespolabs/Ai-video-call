-- Migration: tokenized 3D assets — the platform launch record for a generated
-- GLB minted as a Metaplex Core NFT (see api/_lib/tokenize-3d.js).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260707120000_tokenized_3d_assets.sql
-- Idempotent.
--
-- One row per mint attempt. The row is CLAIMED (status='pending') before any
-- on-chain call so a double-call for the same idempotency key can never
-- double-mint — the second caller reads back the winner's row. On success the
-- row flips to 'minted' with the mint + tx; on a clean failure it flips to
-- 'failed' so the same key can be retried.
--
-- This is the reused "launch record" for tokenized 3D (the NFT analogue of
-- pump_agent_mints, which is pump.fun-coin-specific): the /launches-style read
-- surface (get_3d_asset_onchain + the provenance read-back) keys on it.

begin;

create table if not exists tokenized_3d_assets (
    id               uuid primary key default gen_random_uuid(),
    idempotency_key  text not null,                  -- caller-supplied or derived
    network          text not null check (network in ('mainnet','devnet')),
    status           text not null default 'pending'
                         check (status in ('pending','minted','failed')),
    mint             text,                            -- Core asset pubkey (base58), null until minted
    owner_wallet     text not null,                  -- NFT recipient (base58 Solana pubkey)
    creator_user_id  uuid references users(id) on delete set null,
    source_avatar_id uuid references avatars(id) on delete set null,
    parent_mint      text,                            -- lineage: the asset this was remixed from
    name             text not null,
    glb_url          text not null,                   -- durable GLB (R2 https)
    image_url        text,                            -- durable thumbnail (R2 https)
    viewer_url       text,                            -- live three.ws viewer link
    metadata_uri     text,                            -- Metaplex off-chain JSON (R2 https), null until built
    royalty_bps      int  not null default 500
                         check (royalty_bps between 0 and 1000),   -- hard cap: 10%
    royalty_recipient text,                           -- creator wallet the royalty routes to
    provenance       jsonb not null default '{}'::jsonb,
    tx_signature     text,
    mint_error       text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

-- One claim per (idempotency_key, network) — the double-mint guard.
create unique index if not exists tokenized_3d_assets_idem_uniq
    on tokenized_3d_assets(idempotency_key, network);

-- One row per minted asset — the read-back key.
create unique index if not exists tokenized_3d_assets_mint_uniq
    on tokenized_3d_assets(mint, network) where mint is not null;

create index if not exists tokenized_3d_assets_creator
    on tokenized_3d_assets(creator_user_id);
create index if not exists tokenized_3d_assets_owner
    on tokenized_3d_assets(owner_wallet);
create index if not exists tokenized_3d_assets_created
    on tokenized_3d_assets(created_at desc);

commit;
