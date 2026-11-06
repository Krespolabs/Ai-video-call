-- Migration: $THREE holder snapshot cache.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260621120000_three_holder_snapshot.sql
-- Idempotent + re-runnable.
--
-- Public surfaces (the holder leaderboard, its OG share card, and the token
-- stats panel) previously each ran a full Helius DAS `getTokenAccounts` walk of
-- EVERY $THREE holder on every edge-cache miss — recomputing a slow-changing set
-- on web/bot traffic and burning DAS credits in proportion to page views. This
-- table is the shared, slowly-refreshed snapshot those reads now serve from: a
-- single background cron (api/cron/three-holders-snapshot.js) does ONE scan every
-- few minutes and writes the result here, so public reads cost a DB query, not a
-- Helius walk. The OG-card bot-amplification vector disappears entirely.
--
-- The table is a pure cache (no accrual/payout semantics — that lives in
-- coin_holders): a wallet that fully exits is hard-deleted on the next snapshot.

create table if not exists three_holder_snapshot (
	wallet      text primary key,
	-- Atomic on-chain balance (token base units). $THREE max supply fits in bigint.
	balance     bigint not null,
	updated_at  timestamptz not null default now()
);

-- The leaderboard slices the top holders by descending balance; index it.
create index if not exists three_holder_snapshot_balance_idx
	on three_holder_snapshot (balance desc);

-- Single-row metadata: when the last full snapshot completed + its holder count,
-- so readers can cheaply judge staleness without scanning the table.
create table if not exists three_holder_snapshot_meta (
	id           smallint primary key default 1,
	snapshot_at  timestamptz,
	holder_count integer not null default 0,
	constraint three_holder_snapshot_meta_singleton check (id = 1)
);

insert into three_holder_snapshot_meta (id, snapshot_at, holder_count)
values (1, null, 0)
on conflict (id) do nothing;
