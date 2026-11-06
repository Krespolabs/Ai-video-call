-- Migration: let a paid agent-skill intent reach its terminal 'consumed' state.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260930140000_agent_payment_intents_consumed_status.sql
-- Idempotent.
--
-- consumeIntent() in api/_lib/x402.js flips an intent paid -> consumed as the
-- single-use lock before the paid skill runs, and releaseIntent() flips it back
-- when the skill fails. The original table (2026-04-29-agent-payments.sql)
-- only allowed pending / paid / expired / failed, so the UPDATE raised a check
-- violation AFTER the buyer had already paid on chain: every legacy per-skill
-- invoke died with a 500 and no revenue was ever recorded. Widen the check to
-- include 'consumed'. Every existing row already satisfies the wider set.

begin;

alter table agent_payment_intents
	drop constraint if exists agent_payment_intents_status_check;

alter table agent_payment_intents
	add constraint agent_payment_intents_status_check
	check (status in ('pending', 'paid', 'consumed', 'expired', 'failed'));

commit;
