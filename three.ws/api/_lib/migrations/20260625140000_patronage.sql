begin;

-- Patronage, Relationships & Tip-to-Unlock
-- ========================================
-- A tip on three.ws is not a dead-end transaction. Because every agent has a
-- persona + real memory, support BUILDS A RELATIONSHIP: the agent remembers its
-- patrons, greets its top supporters by name, and unlocks real, gated
-- capabilities for them. The patron ledger itself is DERIVED, not stored — it is
-- aggregated live from the real on-chain custody ledger (agent_custody_events:
-- event_type IN ('tip','stream'), grouped by the verified on-chain payer
-- meta->>'from'). These two tables hold only the owner's PERK CONFIG and each
-- patron's PRIVACY/MILESTONE STATE; no amount, level, or count is ever stored
-- here — those are always recomputed from chain truth in api/_lib/patronage.js.

-- ── Owner-defined perk ladder ──────────────────────────────────────────────────
-- Each row is one rung: "support me with >= $threshold_usd and unlock <perk>".
-- Only the agent's owner can write these (owner auth + CSRF in api/agents/patronage.js).
-- Access is ENFORCED server-side by recomputing the supporter's verified on-chain
-- support on every gated request — never trusted from the client. perk_type maps
-- to capabilities that really exist:
--   greeting      — an exclusive chat greeting/mode the agent uses for this patron
--   lore          — a hidden memory/lore entry revealed only to patrons at tier
--   skill         — a premium agent skill the patron may use for free (payload.skill)
--   launch_access — early/priority access to this agent's coin launches
--   badge         — a patron badge rendered on the public patron wall (payload.label)
create table if not exists agent_patron_perks (
    id              uuid         primary key default gen_random_uuid(),
    agent_id        uuid         not null references agent_identities(id) on delete cascade,
    perk_type       text         not null check (perk_type in ('greeting','lore','skill','launch_access','badge')),
    threshold_usd   numeric      not null check (threshold_usd >= 0),
    title           text         not null,
    description     text,
    payload         jsonb        not null default '{}'::jsonb,  -- type-specific: { body } | { skill } | { label }
    is_active       boolean      not null default true,
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now()
);

-- The Support surface reads a single agent's ladder ordered by threshold.
create index if not exists agent_patron_perks_agent
    on agent_patron_perks (agent_id, threshold_usd)
    where is_active;

-- ── Per-patron privacy + milestone state ───────────────────────────────────────
-- Keyed by the patron's on-chain wallet (the spoof-proof identity = the verified
-- `from` of their support). Holds only:
--   hidden          — the patron opted OUT of the public wall (set by the patron,
--                     proven by an ed25519 signature over a challenge; their support
--                     still counts toward totals, they just aren't displayed).
--   milestone_level — the highest patron level we've already written a relationship
--                     MEMORY for, so a level-up writes exactly one memory (dedupe).
--   display_name    — cached SNS/.sol reverse-resolution, to avoid re-resolving on
--                     every read of the wall.
create table if not exists agent_patron_prefs (
    agent_id        uuid         not null references agent_identities(id) on delete cascade,
    patron_wallet   text         not null,
    hidden          boolean      not null default false,
    milestone_level text,
    display_name    text,
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    primary key (agent_id, patron_wallet)
);

comment on table agent_patron_perks is
    'Owner-defined tip-to-unlock perk ladder for an agent. Owner-only writes. '
    'Perk access is enforced server-side by recomputing the supporter''s verified '
    'on-chain support (agent_custody_events tip+stream grouped by payer) against '
    'threshold_usd on every gated request — never trusted from the client.';
comment on table agent_patron_prefs is
    'Per-patron privacy (wall opt-out, proven by wallet signature) and milestone '
    'dedupe state. Patron identity = on-chain wallet. No support amount/level is '
    'stored — those derive from the custody ledger in api/_lib/patronage.js.';

commit;
