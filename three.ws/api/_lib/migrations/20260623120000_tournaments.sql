-- Migration: Social Trading Arena — time-boxed PvP trading tournaments.
--
-- The Arena turns the verified track-record layer (trader-stats.js over the
-- on-chain agent_sniper_positions ledger) into a recurring competitive product:
-- agents enter a time-boxed competition, are ranked LIVE on real, signature-proven
-- realized PnL over the window, the final standings are committed to Solana as a
-- tamper-evident attestation (kind threews.tournament.v1), and $THREE prizes settle
-- to the winners' wallets.
--
-- Two tables, by design:
--   tournaments        — the competition definition + lifecycle + prize pool.
--   tournament_entries — one row per (tournament, agent), with the join-time
--                        baseline snapshot and, after close, the final rank +
--                        prize + settlement record.
--
-- Integrity is the entire point: rankings derive ONLY from trades OPENED inside
-- the window (snapshotted at join so nothing can be backfilled), prize brackets
-- exclude simulated/paper positions, and every prize payout records a real tx.

begin;

create table if not exists tournaments (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(name) between 1 and 120),
  description        text,
  network            text not null default 'mainnet' check (network in ('mainnet','devnet')),
  -- What the live rank is sorted on. All three derive from the same pure
  -- computeTraderMetrics over the window, so they can never disagree with the
  -- leaderboard or the trader profile.
  scoring            text not null default 'score' check (scoring in ('score','realized_pnl','roi_pct')),
  -- 'prize'   — real on-chain trades only; winners receive $THREE.
  -- 'practice'— simulated/paper trades allowed, clearly labelled, no prizes.
  bracket            text not null default 'prize' check (bracket in ('prize','practice')),
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  -- Anti-cheat + access gates: { min_closed, min_unique_coins, max_churn_pct,
  -- gated:boolean, allow_agents:[uuid] }. Defaults applied in the scoring engine.
  entry_rules        jsonb not null default '{}'::jsonb,
  -- Prize pool in $THREE base units (atomics; THREE_TOKEN_DECIMALS). Practice
  -- brackets keep this 0.
  prize_pool_three   numeric(40, 0) not null default 0,
  -- Payout structure as basis points of the pool by rank: [{rank,bps}, …].
  -- Must sum to <= 10000; the remainder (if any) stays unallocated.
  prize_splits       jsonb not null default '[]'::jsonb,
  status             text not null default 'upcoming'
                       check (status in ('draft','upcoming','live','closed','settled','cancelled')),
  -- Set at close: the Solana tx signature of the standings attestation.
  attestation_sig    text,
  attestation_kind   text,
  created_by         uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint tournaments_window_ordered check (ends_at > starts_at),
  constraint tournaments_prize_nonneg check (prize_pool_three >= 0)
);

create index if not exists tournaments_status_start_idx on tournaments (status, starts_at desc);
create index if not exists tournaments_network_end_idx on tournaments (network, ends_at desc);

create table if not exists tournament_entries (
  id                 uuid primary key default gen_random_uuid(),
  tournament_id      uuid not null references tournaments(id) on delete cascade,
  agent_id           uuid not null references agent_identities(id) on delete cascade,
  -- The agent's Solana trading wallet at join time — the prize destination and
  -- the attestation subject. Denormalized so a later wallet rotation can't redirect
  -- a prize the entrant already earned.
  wallet             text,
  joined_at          timestamptz not null default now(),
  -- All-time metrics snapshot at join (computeTraderMetrics) + closed_count, so
  -- the window scoping is auditable and pre-window history can't be claimed.
  starting_snapshot  jsonb not null default '{}'::jsonb,
  status             text not null default 'active'
                       check (status in ('active','disqualified','withdrawn')),
  dq_reason          text,
  -- Filled at close.
  final_rank         int,
  final_score        numeric,
  prize_three        numeric(40, 0) not null default 0,
  settlement_status  text not null default 'none'
                       check (settlement_status in ('none','pending','settled','blocked')),
  settlement_tx      text,
  settlement_note    text,
  settled_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tournament_id, agent_id)
);

create index if not exists tournament_entries_tid_idx on tournament_entries (tournament_id);
create index if not exists tournament_entries_agent_idx on tournament_entries (agent_id);
-- Idempotency guard for prize settlement: one tx can settle exactly one entry.
create unique index if not exists tournament_entries_settlement_tx_uniq
  on tournament_entries (settlement_tx) where settlement_tx is not null;

commit;
