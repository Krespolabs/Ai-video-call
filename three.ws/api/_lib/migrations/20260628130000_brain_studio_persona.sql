begin;

-- Brain Studio — structured, editable personality with versioned history
-- =======================================================================
-- The persona system already stores a signed `persona_prompt` produced by a
-- one-time 5-question extraction interview. The Brain Studio turns personality
-- into a tangible thing the owner sculpts: continuous trait dimensions (warmth,
-- formality, verbosity, humour, proactivity, risk appetite, directness), tone
-- chips, and characteristic vocabulary, which compile deterministically into
-- that same `persona_prompt` (src/agents/persona-compile.js).
--
-- Two halves:
--   1. persona_traits  — the editable source of truth on the live agent. The
--      compiled prompt above is always derivable from it, but we persist the
--      structure so the sliders restore exactly and a trait diff is possible.
--   2. agent_versions persona snapshot — every Brain Studio save is a real
--      version (sharing the agent's single version timeline with marketplace
--      publishes) carrying the persona prompt + tone tags + traits, so history,
--      diff, and restore all work on real rows.

-- ── Live agent: structured personality ─────────────────────────────────────────
alter table agent_identities
	add column if not exists persona_traits     jsonb not null default '{}'::jsonb;
alter table agent_identities
	add column if not exists persona_updated_at timestamptz;

-- ── Version snapshots: persona alongside the marketplace prompt ────────────────
-- agent_versions is created in 2026-04-29-agent-marketplace.sql (sorts earlier).
alter table agent_versions
	add column if not exists persona_prompt    text;
alter table agent_versions
	add column if not exists persona_tone_tags jsonb not null default '[]'::jsonb;
alter table agent_versions
	add column if not exists persona_traits    jsonb not null default '{}'::jsonb;

-- A "kind" tag distinguishes a persona save from a marketplace publish on the
-- shared timeline so the Brain Studio history view can filter to persona edits.
alter table agent_versions
	add column if not exists kind text not null default 'publish';

commit;
