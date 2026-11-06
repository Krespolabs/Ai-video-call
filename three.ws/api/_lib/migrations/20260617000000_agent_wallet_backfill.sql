-- Migration: guarantee every agent identity has a custodial Solana wallet.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260617000000_agent_wallet_backfill.sql
-- Idempotent.
--
-- Every agent created via POST /api/agents (and the first-login default-agent
-- bootstrap) auto-provisions a real Solana keypair, encrypts the secret, and
-- stores it in agent_identities.meta.encrypted_solana_secret (+ the public
-- meta.solana_address). Agents created before that behavior shipped — or via any
-- path that skipped it — can be missing the wallet, which breaks the deposit /
-- trade / x402 / withdraw surfaces that assume meta.solana_address exists.
--
-- Key generation is JavaScript (Ed25519 keypair + AES-256-GCM secret encryption),
-- not SQL, so the actual provision runs in the paired Node backfill:
--
--     node scripts/backfill-agent-wallets.mjs            # report only
--     node scripts/backfill-agent-wallets.mjs --apply    # provision via ensureAgentWallet()
--
-- That script calls ensureAgentWallet() — the same canonical custody path the
-- request handlers use — so the backfill can never diverge from live behavior.
-- It is idempotent (skips rows that already have a valid wallet) and re-runnable.
--
-- This SQL file exists so the change is tracked in schema_migrations alongside
-- the runner and so the backfill state is observable. It only adds a partial
-- index that makes "agents still missing a wallet" a constant-time lookup for
-- the backfill query, monitoring, and a post-deploy verification that zero rows
-- remain. It writes no keys.

begin;

-- Fast scan for agents that still need a custodial wallet (drives the backfill
-- query and the "zero remaining" verification). Partial so it only indexes the
-- shrinking set of un-provisioned rows.
create index if not exists agent_identities_missing_solana
	on agent_identities (created_at)
	where deleted_at is null
	  and (meta is null or meta->>'solana_address' is null or meta->>'solana_address' = '');

commit;
