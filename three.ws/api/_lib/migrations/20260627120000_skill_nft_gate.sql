-- Migration: NFT-gated skills.
-- ============================================================================
-- Lets a creator restrict a skill to holders of a specific NFT collection
-- instead of (or as well as) selling it for a price. Two new columns on
-- agent_skill_prices:
--
--   • gate_type           — how access is granted:
--                             'price' (default, unchanged) — pay to unlock, or
--                             'nft'   — hold ≥1 NFT from `nft_collection_mint`.
--   • nft_collection_mint — Solana collection mint (base58) required by an NFT
--                           gate; NULL for price gates.
--
-- An NFT gate is NOT a purchase: there is no x402 charge, no skill_purchases
-- row, no fee split. Access is the live answer to "does the caller's wallet
-- currently hold an asset grouped under this collection?" — verified via the
-- Helius DAS API (api/_lib/nft-gate.js) on every execution, fail-closed.
--
-- For an NFT gate the existing fixed-price columns (amount, currency_mint,
-- time_pass_*, pricing_type) are inert: `amount` is stored as 0 so the row stays
-- a valid agent_skill_prices entry (it keeps the skill classified "premium", not
-- "free", in marketplace filters) while the access decision is driven entirely
-- by the on-chain holding check. Skills with no row at all remain free.
--
-- A CHECK constraint keeps the two columns coherent: an 'nft' gate must carry a
-- collection mint; a 'price' gate must not. Both columns are additive with
-- safe defaults, so existing rows become explicit 'price' gates unchanged.
--
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260627120000_skill_nft_gate.sql
-- Idempotent. Migration-only — schema.sql is left untouched per repo policy.
begin;

alter table agent_skill_prices
    add column if not exists gate_type           text not null default 'price',
    add column if not exists nft_collection_mint text;

-- Constrain gate_type to the known set, added separately + guarded so the
-- migration is safe to re-run.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'agent_skill_prices_gate_type_chk'
    ) then
        alter table agent_skill_prices
            add constraint agent_skill_prices_gate_type_chk
            check (gate_type in ('price', 'nft'));
    end if;
end $$;

-- Coherence: an NFT gate must name a collection; a price gate must not carry one.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'agent_skill_prices_nft_gate_chk'
    ) then
        alter table agent_skill_prices
            add constraint agent_skill_prices_nft_gate_chk
            check (
                (gate_type = 'nft'   and nft_collection_mint is not null and length(nft_collection_mint) > 0)
                or
                (gate_type = 'price' and nft_collection_mint is null)
            );
    end if;
end $$;

commit;
