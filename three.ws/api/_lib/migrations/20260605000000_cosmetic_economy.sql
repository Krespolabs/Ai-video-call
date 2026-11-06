-- Migration: cosmetic creator revenue splits + settled-sale ledger (R25).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260605000000_cosmetic_economy.sql
--   (or `npm run db:migrate`). Idempotent — safe to re-run.
--
-- Extends the R22 avatar-shop rail (api/x402/cosmetic-purchase.js): a premium
-- cosmetic bought inside a coin's /play world settles real USDC over x402, and a
-- configurable share of that settled USDC is paid out — a REAL on-chain USDC
-- transfer (api/_lib/solana-transfer.js) — to that coin's creator wallet. These
-- tables are the queryable record the creator-earnings dashboard and the platform
-- "rarest fits" leaderboard read. All amounts are USDC atomics (6 decimals), the
-- asset the x402 rail actually settles; the shop quotes value in $THREE separately.
--
--   1. cosmetic_creator_splits — per-coin config: the creator wallet that earns the
--      share + the share in basis points (creator-adjustable up to a platform cap).
--   2. cosmetic_sales — one row per settled purchase (idempotent on account+
--      cosmetic), carrying the creator cut and the payout's on-chain status/tx so
--      the dashboard shows only real, settled+paid numbers and a sweep can retry a
--      failed payout.

begin;

-- Per-coin split configuration. A missing row means "resolve the creator from
-- launch records and apply the platform default share".
create table if not exists cosmetic_creator_splits (
	mint           text primary key,                       -- base58 coin mint (the /play world)
	creator_wallet text not null,                           -- base58 Solana address that earns the share
	split_bps      integer not null
	                 check (split_bps >= 0 and split_bps <= 10000),
	updated_by     text,                                    -- wallet that last set this (the creator)
	created_at     timestamptz not null default now(),
	updated_at     timestamptz not null default now()
);

-- Settled cosmetic sales. One row per (account, cosmetic) — premium unlocks are
-- buy-once-per-account, so this natural key is the idempotency guard: a replayed
-- settle or a SIWX re-access conflicts and never double-records or double-pays.
create table if not exists cosmetic_sales (
	id                  uuid primary key default gen_random_uuid(),
	account             text not null,                      -- account the cosmetic was granted to
	payer_wallet        text,                               -- paying wallet (may differ from account)
	payer_network       text,                               -- 'base' | 'solana'
	mint                text,                               -- coin world the sale was tied to (null = untied)
	cosmetic_id         text not null,                      -- catalog id (e.g. 'skin-midnight')
	rarity              text not null default 'common',     -- denormalized for the leaderboard
	price_usdc_atomics  numeric(20,0) not null,             -- total USDC charged (atomics, 6dp)
	asset               text,                               -- settlement asset address
	creator_wallet      text,                               -- recipient of the creator cut (null = none)
	split_bps           integer not null default 0,         -- creator share applied at settle time
	creator_cut_atomics numeric(20,0) not null default 0,   -- creator cut in USDC atomics
	-- Payout lifecycle: 'none' (no creator/cut), 'pending' (accrued, not yet sent),
	-- 'paid' (on-chain), 'failed' (retriable by the sweep), 'skipped' (no treasury).
	payout_status       text not null default 'none'
	                      check (payout_status in ('none', 'pending', 'paid', 'failed', 'skipped')),
	payout_tx           text,                               -- on-chain signature of the creator payout
	payout_network      text,                               -- network the payout settled on
	payout_error        text,                               -- last failure reason (when 'failed')
	settled_at          timestamptz not null default now(),
	paid_at             timestamptz,
	unique (account, cosmetic_id)
);

create index if not exists cosmetic_sales_creator
	on cosmetic_sales (creator_wallet, settled_at desc)
	where creator_wallet is not null;

create index if not exists cosmetic_sales_mint
	on cosmetic_sales (mint, settled_at desc);

create index if not exists cosmetic_sales_cosmetic
	on cosmetic_sales (cosmetic_id);

-- Sweep target: rows whose creator cut hasn't landed on-chain yet.
create index if not exists cosmetic_sales_unpaid
	on cosmetic_sales (payout_status, settled_at)
	where payout_status in ('pending', 'failed');

-- Auto-bump updated_at on the config table; reuse the standard trigger fn.
do $$ begin
	create trigger cosmetic_creator_splits_set_updated_at before update on cosmetic_creator_splits
		for each row execute function set_updated_at();
exception when undefined_function then null; when duplicate_object then null; end $$;

commit;
