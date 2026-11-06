-- Migration: add included_skills to creator subscription plans (tiers).
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260618000000_subscription_plan_skills.sql
-- Idempotent.
--
-- A subscription tier bundles access to a chosen set of the agent's paid
-- skills. Creators pick which skills are included from the agent-edit
-- Monetization tab; the array holds skill names (matching the keys used in
-- agent_identities.skill_prices). The user-facing subscription flow grants a
-- subscriber access to exactly these skills for the life of their period.

begin;

alter table subscription_plans
    add column if not exists included_skills text[] not null default '{}';

commit;
