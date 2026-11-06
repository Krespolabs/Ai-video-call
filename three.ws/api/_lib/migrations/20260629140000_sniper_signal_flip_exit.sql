-- Migration: allow the 'signal_flip' sniper exit reason.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260629140000_sniper_signal_flip_exit.sql
-- Idempotent.
--
-- The sniper already pays real USDC (x402) for per-coin sentiment, persisted to
-- sniper_coin_sentiment. This exit reason lets that paid intel actually drive a
-- sell: when a held coin's signal flips strongly bearish while the position is
-- underwater, the worker can cut the loser early instead of waiting for the hard
-- stop-loss. Opt-in at the worker (SNIPER_EXIT_ON_BEARISH) — existing strategies
-- are unaffected until an operator enables it.
--
-- Widens the agent_sniper_positions.exit_reason CHECK to include 'signal_flip'.

begin;

alter table agent_sniper_positions
    drop constraint if exists agent_sniper_positions_exit_reason_check;

alter table agent_sniper_positions
    add constraint agent_sniper_positions_exit_reason_check
    check (exit_reason in
        ('take_profit','stop_loss','trailing_stop','timeout',
         'manual','kill_switch','graduated','error','signal_flip'));

commit;
