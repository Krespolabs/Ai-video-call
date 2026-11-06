-- Agent Studio — namespaced `meta.studio` sub-object (Brain / Body / Trading).
--
-- The Studio (P0 shell + P1 Brain + P2 Memory + P3 Body + P4 Trading) stores all
-- of its visual, user-authored configuration inside the existing jsonb `meta`
-- column, under a single `studio` key so it never collides with the wallet,
-- onchain, token, or payments blocks already living in `meta`.
--
-- Shape (additive, schema-less by design — documented here so P1–P5 bind to a
-- stable contract):
--
--   meta.studio = {
--     "studio_version": 1,           -- bumped on breaking changes to the bag
--     "brain":   { ... },            -- P1: visual brain graph (nodes/edges) + compiled snapshot
--     "memory":  { ... },            -- P2: memory tiers / access config
--     "body":    { ... },            -- P3: outfit / animation refs
--     "trading": { ... }             -- P4: trading rules / risk config
--   }
--
-- The Brain graph (meta.studio.brain.graph) is the canonical persona. The Brain
-- Studio compiles it to the real `persona_prompt` column (consumed by
-- api/chat.js) on every save, so existing chat surfaces keep working without
-- knowing the graph exists.
--
-- This migration is intentionally additive: `meta` is already jsonb, so no
-- column changes are required. We document the contract on the column and add a
-- GIN index so future "find agents whose brain uses provider X" queries over the
-- studio bag stay index-backed instead of seq-scanning every agent.

comment on column agent_identities.meta is
  'Free-form jsonb. Reserved namespaces: onchain, token, payments, wallet encryption keys, and `studio` (Agent Studio: studio.brain / studio.memory / studio.body / studio.trading + studio.studio_version). See migration 20260619150000_agent_studio.sql.';

create index if not exists idx_agent_identities_meta_gin
  on agent_identities using gin (meta jsonb_path_ops);
