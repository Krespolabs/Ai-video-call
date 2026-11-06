-- Migration: MEV-Aware Execution Engine — Jito bundle telemetry + per-strategy tip mode.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260620062600_mev_execution.sql
-- Idempotent.
--
-- The execution engine (api/_lib/execution-engine.js) replaces the sniper's and
-- the discretionary endpoints' raw single-tx broadcast with a protected path:
-- a data-driven compute budget (real simulate + real priority-fee estimate), an
-- optional real Jito Block Engine bundle with an adaptive SOL tip, simulate-then-
-- send with bounded adaptive retry, and honest landing telemetry. This migration:
--
--   1. agent_sniper_strategies.mev_tip_mode — per-strategy Jito tip policy.
--      'off'     (default): never pay a Jito tip; submit the protected single tx.
--      'economy': pay a small tip near the tip-floor when a bundle route is viable.
--      'turbo':   pay an aggressive tip for first-block inclusion under contention.
--
--   2. agent_sniper_positions execution telemetry (all nullable — a position
--      opened before this migration, or in simulate mode, simply has nulls):
--      exec_route                — 'jito_turbo' | 'jito_economy' | 'protected' | 'simulated'
--      tip_lamports              — real SOL tip paid to the Jito tip account (0 when none)
--      priority_fee_microlamports — the compute-unit price actually set on the tx
--      landed_ms                 — wall-clock ms from first submit to confirmed landing

begin;

-- ── per-strategy Jito tip policy ─────────────────────────────────────────────
alter table agent_sniper_strategies
    add column if not exists mev_tip_mode text not null default 'off'
        check (mev_tip_mode in ('off', 'economy', 'turbo'));

-- ── execution telemetry on each position ─────────────────────────────────────
alter table agent_sniper_positions
    add column if not exists exec_route text
        check (exec_route is null or exec_route in
            ('jito_turbo', 'jito_economy', 'protected', 'simulated'));

alter table agent_sniper_positions
    add column if not exists tip_lamports numeric(20, 0);

alter table agent_sniper_positions
    add column if not exists priority_fee_microlamports numeric(20, 0);

alter table agent_sniper_positions
    add column if not exists landed_ms integer;

commit;
