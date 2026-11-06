-- Migration: skill_access_grants — the authoritative "does user X hold access to
-- skill Y on agent Z?" record, created the moment a payment is confirmed.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260618000000_skill_access_grants.sql
-- Idempotent.
--
-- skill_purchases tracks the PAYMENT lifecycle (pending → confirmed → …).
-- skill_access_grants tracks the resulting ACCESS, decoupled from payment so a
-- grant can be issued by a one-time purchase, a time-pass, a gift, or any future
-- entitlement path without re-modelling each one onto the purchase row.
--
-- Populated by finalizeSkillConfirmation() in api/_lib/purchase-confirm.js once
-- an on-chain payment is verified. Grant shape:
--   expires_at NULL              — permanent access (one-time purchase)
--   expires_at <timestamptz>     — time-limited access (expires at the window)
--   uses_left  NULL              — unmetered access (time-based model)
--   uses_left  <integer>         — metered access, decremented per use
-- A user holds at most one grant per (agent, skill); re-purchase extends it via
-- ON CONFLICT (user_id, agent_id, skill_name) DO UPDATE.

begin;

create table if not exists skill_access_grants (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users(id) on delete cascade,
    agent_id    uuid not null references agent_identities(id) on delete cascade,
    skill_name  text not null,
    purchase_id uuid references skill_purchases(id) on delete set null,
    expires_at  timestamptz,
    uses_left   integer,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    unique (user_id, agent_id, skill_name)
);

-- Hot path: "what does this user own?" (collection page) and the per-skill
-- access gate the executor consults before running a paid skill.
create index if not exists idx_skill_access_grants_user
    on skill_access_grants (user_id);
create index if not exists idx_skill_access_grants_agent
    on skill_access_grants (agent_id);
create index if not exists idx_skill_access_grants_lookup
    on skill_access_grants (user_id, agent_id, skill_name);

-- Auto-bump updated_at on any UPDATE; reuse the standard trigger function that
-- skill_purchases and the rest of the schema already rely on.
do $$ begin
    create trigger skill_access_grants_set_updated_at before update on skill_access_grants
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

commit;
