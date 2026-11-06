-- Migration: extend copy_executions to support Oracle conviction actions.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260616130000_oracle_copy_fanout.sql
-- Idempotent.
--
-- The copy-fanout cron previously only read from agent_sniper_positions (the sniper
-- engine). This migration adds oracle_watch_actions as a second fanout source:
-- when an oracle-armed agent fires a live buy, copy subscribers get the same
-- sized, safety-checked intent they would from a sniper position.
--
-- Schema changes:
--   1. leader_position_id  — made nullable (oracle fanout rows don't have one)
--   2. leader_oracle_action_id — new bigint FK to oracle_watch_actions.id
--   3. Unique constraint replaced with two partial unique indexes, one per source type,
--      so idempotency is guaranteed for both sniper and oracle fanout paths.

begin;

-- 1. Make leader_position_id nullable so oracle-sourced rows can omit it.
alter table copy_executions
    alter column leader_position_id drop not null;

-- 2. Add oracle action reference (nullable; set only for oracle-sourced intents).
alter table copy_executions
    add column if not exists leader_oracle_action_id bigint;

-- 3. Drop old scalar unique constraint (postgres won't auto-drop when we add the partial indexes).
alter table copy_executions
    drop constraint if exists copy_executions_subscription_id_leader_position_id_direction_key;

-- 4. Partial unique indexes — one per source type.
--    Sniper path: idempotency on (sub, sniper_position, direction) when position is set.
create unique index if not exists copy_executions_sniper_idem
    on copy_executions (subscription_id, leader_position_id, direction)
    where leader_position_id is not null;

--    Oracle path: idempotency on (sub, oracle_action, direction) when action is set.
create unique index if not exists copy_executions_oracle_idem
    on copy_executions (subscription_id, leader_oracle_action_id, direction)
    where leader_oracle_action_id is not null;

-- 5. Lookup index for oracle action references.
create index if not exists copy_executions_oracle_action
    on copy_executions (leader_oracle_action_id)
    where leader_oracle_action_id is not null;

commit;
