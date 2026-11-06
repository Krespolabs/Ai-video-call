-- Add a 'settling' interim status to royalty_ledger.
--
-- settleRoyalties() redeems real USDC on-chain, then marks rows settled. Two
-- concurrent settle runs (the cron pass + a manual trigger, or overlapping cron
-- invocations) could both SELECT the same 'pending' rows and both redeem before
-- either marked them settled — a double-pay. The fix claims rows atomically
-- (UPDATE … SET status='settling' WHERE status='pending' RETURNING) before the
-- redeem, so only one run owns a given ledger row and the on-chain transfer
-- happens at most once. That interim state needs to satisfy the CHECK
-- constraint, which previously allowed only pending/settled/failed.
--
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260619000000_royalty_settling_status.sql
-- Idempotent.

begin;

alter table royalty_ledger
    drop constraint if exists royalty_ledger_status_check;

alter table royalty_ledger
    add constraint royalty_ledger_status_check
    check (status in ('pending', 'settling', 'settled', 'failed'));

commit;
