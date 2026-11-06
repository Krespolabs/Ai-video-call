-- Migration: indexes backing holder cohorts
--
-- Holder cohorts (api/_lib/coin/cohorts.js) are derived queries over the
-- existing coin_holders set — no new table. They filter positive holders by
-- first_seen (diamond hands / new buyers) and find exited wallets (balance = 0)
-- by last_seen. The existing partial index coin_holders_coin_balance covers the
-- balance-ordered whale/holder scans; these two add the time-bounded paths so
-- cohort queries on large coins stay index-only instead of seq-scanning.
--
-- Idempotent: safe to re-run.

begin;

-- Diamond-hands / new-buyers: positive holders ordered/filtered by age.
create index if not exists coin_holders_coin_first_seen
	on coin_holders(coin_id, first_seen) where balance > 0;

-- Exited (win-back): wallets sold to zero, found by when they left.
create index if not exists coin_holders_coin_exited_last_seen
	on coin_holders(coin_id, last_seen) where balance = 0;

commit;
