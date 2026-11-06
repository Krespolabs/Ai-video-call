-- Migration: Coin Wars — the battle ledger behind community-vs-community clashes.
-- Each row is one finished clash between two coin communities, written by the
-- multiplayer game server (ClashRoom) over an HMAC-signed POST to /api/wars?action=
-- report. The /wars War Standings are RECOMPUTED from this ledger with the pure Elo
-- league math in multiplayer/src/war-standings.js, so the ledger is the single source
-- of truth and ratings can be re-derived deterministically from it at any time.
--
-- We store both the indexable outcome columns (for the recent-battles feed and
-- head-to-head queries) and the per-faction kill/death tallies the standings fold
-- needs, so a standings rebuild never has to reach back into game-server memory.

begin;

create table if not exists clash_battles (
  id            uuid primary key default gen_random_uuid(),
  -- The arena instance this battle was fought in (network + the two mints). Unique
  -- so a re-reported result (game server retry) updates rather than double-counts.
  match_key     text not null,
  network       text not null default 'mainnet',
  -- Outcome. winner_mint is NULL for a draw; reason is how it ended
  -- (score_cap | timeout | sudden_death | forfeit).
  winner_mint   text,
  reason        text not null default 'score_cap',
  duration_ms   integer not null default 0,
  -- Faction A.
  a_mint        text not null,
  a_name        text not null default '',
  a_symbol      text not null default '',
  a_score       integer not null default 0,
  a_kills       integer not null default 0,
  a_deaths      integer not null default 0,
  -- Faction B.
  b_mint        text not null,
  b_name        text not null default '',
  b_symbol      text not null default '',
  b_score       integer not null default 0,
  b_kills       integer not null default 0,
  b_deaths      integer not null default 0,
  -- Match MVP { id, faction, kills, deaths, damage } as reported by the engine.
  mvp           jsonb,
  ended_at      timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  constraint clash_battles_distinct_factions check (a_mint <> b_mint)
);

-- One canonical row per arena instance — a retry of the same battle's report upserts.
create unique index if not exists clash_battles_match_key_uniq on clash_battles (match_key);
-- The recent-battles feed reads newest-first per network.
create index if not exists clash_battles_network_ended_idx on clash_battles (network, ended_at desc);
-- Per-community history (a coin's battle log + head-to-head) hits either faction column.
create index if not exists clash_battles_a_mint_idx on clash_battles (a_mint, ended_at desc);
create index if not exists clash_battles_b_mint_idx on clash_battles (b_mint, ended_at desc);

commit;
