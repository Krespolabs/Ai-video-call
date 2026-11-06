-- Migration: "Pay What You Want" (PWYW) skill pricing.
--
-- Adds two columns to agent_skill_prices so a creator can mark a skill as
-- PWYW instead of fixed-price:
--   • pricing_type   — 'fixed' (default, unchanged behavior) or 'pwyw'.
--   • minimum_amount — atomic-units floor for a PWYW purchase (nullable; NULL or
--                      0 means "any amount, including free + a tip"). Ignored
--                      for fixed-price skills, where `amount` is authoritative.
--
-- For a PWYW skill, agent_skill_prices.amount remains the SUGGESTED price the
-- buyer UI pre-fills; the actual charged amount is the buyer-chosen value
-- snapshotted onto skill_purchases.amount at create time and verified on-chain at
-- confirm — the existing fee/referral/revenue math already keys off that snapshot,
-- so it bills exactly what the buyer paid.
--
-- Idempotent. Migration-only — schema.sql is left untouched per repo policy.
begin;

alter table agent_skill_prices
    add column if not exists pricing_type   text   not null default 'fixed',
    add column if not exists minimum_amount bigint;

-- Constrain pricing_type to the known set. Added separately + guarded so the
-- migration is safe to re-run and won't fail if the constraint already exists.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'agent_skill_prices_pricing_type_chk'
    ) then
        alter table agent_skill_prices
            add constraint agent_skill_prices_pricing_type_chk
            check (pricing_type in ('fixed', 'pwyw'));
    end if;
end $$;

commit;
