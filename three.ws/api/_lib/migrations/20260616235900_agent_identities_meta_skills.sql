-- Migration: declare agent_identities.meta and agent_identities.skills.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260616235900_agent_identities_meta_skills.sql
-- Idempotent — additive only, safe to re-run.
--
-- Every agent create path (api/agents.js:154 first-login bootstrap, :281 explicit
-- create) writes BOTH columns:
--   • meta   — custodial wallet keys (encrypted_solana_secret / encrypted_wallet_key),
--              the public solana_address, the unified onchain block, persona,
--              payments, spend_limits, etc. Provisioning (api/_lib/agent-wallet.js
--              ensureAgentWallet/getOrCreateAgentSolanaWallet) and the task-01
--              wallet backfill (20260617000000_agent_wallet_backfill.sql) all
--              read/write meta->>'solana_address'.
--   • skills — the agent's skill list, bound as a RAW Postgres array by the driver
--              (no JSON.stringify) and queried with `skills @> '{…}'::text[]`
--              (api/agents/public.js:61), so the column MUST be text[], never jsonb.
--
-- The canonical bootstrap schema (api/_lib/schema.sql) historically never declared
-- either column; existing deployments only worked because they were hand-added
-- out-of-band. This migration converges every existing DB to the same shape the
-- (now-corrected) schema.sql produces on a fresh apply, so the manual deploy-order
-- dependency can never bite again. It adds NO data and changes NO behavior — it
-- only guarantees the columns the provisioning code already assumes.

begin;

-- meta: canonical jsonb blob. Default '{}' so a row inserted without meta (or a
-- legacy row predating the column) reads as an empty object, never NULL — every
-- meta->>'…' lookup in the wallet/onchain path stays null-safe.
alter table agent_identities add column if not exists meta   jsonb  not null default '{}'::jsonb;

-- skills: text[] (Postgres array), matching how api/agents.js binds it and how
-- api/agents/public.js filters it with `@> '{…}'::text[]`. Default '{}' = no skills.
alter table agent_identities add column if not exists skills text[] not null default '{}'::text[];

-- Document the meta contract for future readers (mirrors the richer note added by
-- 2026-04-29-onchain-unified.sql; harmless to set twice).
comment on column agent_identities.meta is
	'jsonb. Custodial wallet (encrypted_solana_secret, solana_address, '
	'encrypted_wallet_key), unified on-chain identity at meta.onchain, persona, '
	'payments, and spend_limits. Secrets never leave the server.';

commit;
