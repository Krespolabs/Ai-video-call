-- Migration: Agent Studio meta contract (P0 foundation).
--
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260619010000_agent_studio.sql
-- Idempotent — additive only, NO column drops, NO type changes, NO data rewrites.
--
-- Agent Studio is the single surface where a user authors an agent's brain,
-- memory, body, money, and skills. Everything Studio (and the sub-studios P1-P5)
-- persist lives under a NAMESPACED jsonb sub-object on the existing
-- agent_identities.meta column — we add NO new columns, because meta is already
-- declared `jsonb not null default '{}'` (20260616235900_agent_identities_meta_skills.sql)
-- and PUT /api/agents/:id already deep-merges client meta over the stored row
-- while carrying the encrypted custodial-wallet keys through untouched.
--
-- ── meta.studio shape (the stable contract P1-P5 bind to) ───────────────────
--   meta.studio = {
--     studio_version : int      -- schema version of the studio bag (currently 1)
--     brain   : { model, provider, graph, ... }     -- P1  (model/provider/graph)
--     memory  : { ... }                             -- P2  (memory config/policy)
--     body    : { outfit, animation, animationRefs } -- P3 (outfit/animation refs)
--     money   : { ... }                             -- P4  (payouts/pricing knobs)
--     trading : { rules, ... }                      -- P5  (trade automation rules)
--     skills  : { ... }                             -- skills surface config
--   }
-- The server (api/agents.js validateStudioMeta) rejects any OTHER top-level key
-- inside meta.studio and size-limits the bag, so this set is authoritative.
-- Secrets NEVER live here — custodial keys stay at meta.encrypted_* and are
-- stripped from every read (api/agents.js decorate()).
--
-- This migration:
--   1. (re)states the meta contract as a column comment for future readers.
--   2. Adds a GIN index on meta so future Studio queries (e.g. "agents whose
--      brain.provider = x", marketplace filtering by body/skills config) are
--      index-backed instead of full scans. jsonb_path_ops keeps the index small
--      and fast for the @> containment queries those lookups use.

begin;

create index if not exists idx_agent_identities_meta_gin
	on agent_identities using gin (meta jsonb_path_ops);

comment on column agent_identities.meta is
	'jsonb. Custodial wallet (encrypted_solana_secret, solana_address, '
	'encrypted_wallet_key — secrets stripped on read), unified on-chain identity '
	'at meta.onchain, persona, payments, spend_limits, AND the Agent Studio bag '
	'at meta.studio { studio_version, brain, memory, body, money, trading, skills }. '
	'meta.studio top-level keys are whitelisted + size-limited by '
	'api/agents.js validateStudioMeta. Secrets never leave the server.';

commit;
