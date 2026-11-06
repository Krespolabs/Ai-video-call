-- Subscription billing idempotency: at most ONE pending payment per subscription
-- per billing period. Without this, every cron pass over an unpaid subscription
-- mints a fresh subscription_payments row + agent_payment_intents row, so a
-- subscriber accumulates many distinct payable intents for a single period and
-- could pay (and be period-advanced for) more than one.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260621122000_subscription-payment-idempotency.sql
-- Idempotent.

begin;

-- The period this payment is for (the subscription's current_period_end at charge
-- time). Nullable for legacy rows; new charges always set it.
alter table subscription_payments add column if not exists period_end timestamptz;

-- One pending charge per (subscription, period). NULL period_end rows (legacy) are
-- distinct under a unique index, so this never blocks existing data, and only
-- 'pending' rows are constrained — succeeded/failed history is unaffected.
create unique index if not exists subscription_payments_one_pending_per_period
    on subscription_payments (subscription_id, period_end)
    where status = 'pending' and period_end is not null;

commit;
