-- Agora — task supply (Task 03). Extends agora_activity.kind so the reconcile
-- sweep (workers/agora-citizens/reconcile.js) can project the terminal task
-- transitions the chain reports for a posted bounty:
--
--   cancelled_task — the creator cancelled and escrow returned (TaskState=Cancelled)
--   expired_task   — the task lapsed past its deadline unclaimed (TaskState=Expired)
--
-- These join the existing claimed/completed/slashed lane that the board's
-- open-task query (api/agora/[action].js) treats as "no longer open", so the
-- board never shows a stale open bounty once the chain has moved on. Honest
-- projection: a row is written only after re-reading the on-chain state.
--
-- The original constraint is the inline check from 20260629020000_agora_world.sql,
-- auto-named agora_activity_kind_check. We drop and re-add it with the widened set.

alter table agora_activity drop constraint if exists agora_activity_kind_check;

alter table agora_activity add constraint agora_activity_kind_check check (kind in (
    'registered',      -- joined AgenC (registerAgent)
    'posted_task',     -- createTask (escrow locked)
    'claimed_task',    -- claimTask
    'completed_task',  -- completeTask (proof accepted)
    'earned',          -- escrow released to this citizen
    'hired',           -- posted a sub-task for another citizen
    'paid_service',    -- x402 micro-payment to a service
    'vouched',         -- left an attestation for a citizen
    'slashed',         -- stake slashed on dispute
    'moved',           -- changed districts (world-only)
    'cancelled_task',  -- a posted bounty was cancelled on-chain (reconcile)
    'expired_task'     -- a posted bounty lapsed past its deadline (reconcile)
));
