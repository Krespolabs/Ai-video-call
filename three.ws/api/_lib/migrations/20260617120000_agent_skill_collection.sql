-- Migration: per-agent skill NFT collection.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260617120000_agent_skill_collection.sql
-- Idempotent.
--
-- Each agent gets its OWN Metaplex Core collection that acts as the master
-- identifier for every "skill ownership" NFT minted to users who buy that
-- agent's skills. This is distinct from the platform-wide "three.ws Agents"
-- collection (configured via SOLANA_AGENT_COLLECTION_* env, see
-- api/_lib/solana-collection.js) — that one groups the agent identity assets
-- themselves; these per-agent collections group skill purchases.
--
-- Created by scripts/create-agent-collection.mjs, which writes the resulting
-- collection mint address back here.

begin;

alter table agent_identities
    add column if not exists skill_collection_mint       text,
    add column if not exists skill_collection_network    text
        check (skill_collection_network in ('mainnet', 'devnet')),
    add column if not exists skill_collection_uri        text,
    add column if not exists skill_collection_tx         text,
    add column if not exists skill_collection_created_at timestamptz;

-- One collection address maps to exactly one agent; lets verifiers resolve an
-- agent from a skill NFT's on-chain collection field.
create unique index if not exists agent_identities_skill_collection_mint
    on agent_identities (skill_collection_mint)
    where skill_collection_mint is not null;

commit;
