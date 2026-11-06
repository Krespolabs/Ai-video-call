-- Migration: skill-ownership NFT mint record on skill_purchases.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260617130000_skill_nft_mints.sql
-- Idempotent.
--
-- After a skill purchase is confirmed on-chain, /api/skills/mint mints a
-- Metaplex Core "skill ownership" NFT to the buyer's wallet from the agent's
-- per-agent skill collection (see 20260617120000_agent_skill_collection.sql).
-- That NFT is the perpetual on-chain receipt + license. These columns make the
-- mint idempotent — one NFT per confirmed purchase — and let read endpoints
-- surface the mint address back to the buyer's wallet/explorer.

begin;

alter table skill_purchases
    add column if not exists skill_nft_mint      text,
    add column if not exists skill_nft_signature text,
    add column if not exists skill_nft_network   text
        check (skill_nft_network in ('mainnet', 'devnet')),
    add column if not exists skill_nft_minted_at timestamptz;

-- A given on-chain asset belongs to exactly one purchase; this also doubles as
-- the idempotency backstop should two concurrent mint calls ever race.
create unique index if not exists skill_purchases_skill_nft_mint
    on skill_purchases (skill_nft_mint)
    where skill_nft_mint is not null;

commit;
