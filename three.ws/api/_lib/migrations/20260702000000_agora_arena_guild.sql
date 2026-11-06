-- Agora — Arena (Competitive) + Guild (Collaborative) multi-worker tasks (Task 09).
-- Extends agora_activity.kind so the life engine + reconcile sweep can project the
-- two new outcomes a multi-worker task produces:
--
--   settled     — a WHOLE multi-worker task resolved on-chain: an Arena winner took
--                 the full escrow, or a Guild finished and its pool split across
--                 contributors. This is the terminal that closes an Arena/Guild off
--                 the open board (the per-worker claimed/completed rows never do,
--                 since several citizens engage the same PDA).
--   stood_down  — an Arena racer did the REAL work but another citizen's proof was
--                 accepted first, so it earns nothing. The loss has no winning tx
--                 (it is the ABSENCE of a completion), so idempotency for this kind
--                 is by (citizen_id, task_pda) — see store.taskActivityExists.
--
-- We drop and re-add the auto-named check with the widened set (mirrors
-- 20260629030000_agora_task_lifecycle.sql). Honest projection: a row is written
-- only after the chain reports the outcome — the engine never fabricates a winner
-- or a split.

alter table agora_activity drop constraint if exists agora_activity_kind_check;

alter table agora_activity add constraint agora_activity_kind_check check (kind in (
    'registered',      -- joined AgenC (registerAgent)
    'posted_task',     -- createTask (escrow locked)
    'claimed_task',    -- claimTask (a worker took / entered the task)
    'completed_task',  -- completeTask (proof accepted)
    'earned',          -- escrow released to this citizen
    'hired',           -- posted a sub-task for another citizen
    'paid_service',    -- x402 micro-payment to a service
    'vouched',         -- left an attestation for a citizen
    'slashed',         -- stake slashed on dispute
    'moved',           -- changed districts (world-only)
    'cancelled_task',  -- a posted bounty was cancelled on-chain (reconcile)
    'expired_task',    -- a posted bounty lapsed past its deadline (reconcile)
    'settled',         -- an Arena/Guild resolved on-chain (winner took all / pool split)
    'stood_down'       -- an Arena racer's proof lost the race (real work, no purse)
));
