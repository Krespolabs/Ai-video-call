-- Migration: gifting skills.
-- A buyer can purchase a skill for another user. The payer stays in `user_id`
-- (they sign the on-chain payment, poll confirm, and own the receipt); the
-- beneficiary who receives access is recorded in `recipient_user_id`.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260618140000_skill_gifts.sql
-- Idempotent.
--
-- Beneficiary = COALESCE(recipient_user_id, user_id):
--   • self-purchase → recipient_user_id NULL → beneficiary is the buyer.
--   • gift          → recipient_user_id set  → beneficiary is the recipient.
-- The access grant (skill_access_grants) and the already-owned short-circuit
-- both key off the beneficiary, so a buyer may gift the same skill to many
-- distinct recipients while still never double-paying for their own copy.

begin;

alter table skill_purchases
	add column if not exists recipient_user_id uuid references users(id);

create index if not exists skill_purchases_recipient
	on skill_purchases (recipient_user_id)
	where recipient_user_id is not null;

-- Replace the per-buyer active-ownership guard with a per-beneficiary one, so
-- "at most one active (confirmed/trial) copy" is enforced against whoever
-- actually receives the skill — not the wallet that paid for it.
drop index if exists skill_purchases_one_active_per_user;
drop index if exists skill_purchases_one_active_per_beneficiary;
create unique index if not exists skill_purchases_one_active_per_beneficiary
	on skill_purchases (coalesce(recipient_user_id, user_id), agent_id, skill)
	where status in ('confirmed', 'trial');

commit;
