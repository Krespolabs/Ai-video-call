begin;

-- Scoped session keys — capability-based security for autonomous agent spending.
--
-- Today every skill / strategy / integration an agent runs wields the FULL
-- authority of the custodial wallet: any of them can spend up to the wallet-wide
-- caps, anywhere policy allows. A capability narrows that to a least-privilege
-- slice: "this sniper strategy may spend up to 2 SOL on these mints for the next
-- 24h, and nothing else." Capabilities strictly SUBTRACT authority — both the
-- capability ceiling and the wallet-wide policy (meta.spend_limits) must pass on
-- every autonomous spend. They never widen what the wallet policy already allows.
--
-- A grant is tamper-evident: `grant_sig` is an HMAC over the immutable scope keyed
-- by a server-held secret, verified server-side on every use. A DB-write attacker
-- who forges or edits a row produces a grant whose HMAC no longer verifies, so the
-- spend path rejects it (fail safe). Expiry and revocation are also enforced
-- server-side on every use, never client-trusted.
--
-- Enforcement lives in api/_lib/wallet-capabilities.js (pure predicates + atomic,
-- advisory-locked aggregate accounting) and is composed into the shared guards in
-- api/_lib/agent-trade-guards.js. Aggregate spend per capability is summed from
-- agent_custody_events rows tagged with capability_id (added below), the same way
-- the wallet daily ceiling is summed — one ledger, two ceilings.
create table if not exists agent_wallet_capabilities (
    id              uuid         primary key default gen_random_uuid(),
    agent_id        uuid         not null,
    user_id         uuid         not null,            -- owner who minted the grant
    label           text         not null,            -- holder display ("Sniper · BONK strategy")
    holder_kind     text         not null default 'manual', -- skill | strategy | integration | manual
    holder_ref      text,                              -- stable id of the holder (strategy id / service host / skill key)
    actions         text[]       not null,             -- allowed action types: trade | snipe | x402
    per_use_usd     numeric,                           -- max USD per single use (null = no per-use cap)
    aggregate_usd   numeric,                           -- lifetime USD ceiling (null = none)
    target_kind     text         not null default 'any', -- mint | service | destination | any
    targets         text[]       not null default '{}', -- allowlist; empty = any target within `actions`
    expires_at      timestamptz  not null,             -- hard expiry; a capability is always time-boxed
    revoked_at      timestamptz,                       -- set on revoke; checked on every use
    revoked_reason  text,
    grant_sig       text         not null,             -- HMAC tag over the immutable scope (tamper-evidence)
    use_count       integer      not null default 0,
    last_used_at    timestamptz,
    meta            jsonb        not null default '{}'::jsonb,
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now()
);

-- The owner-facing Access surface lists a wallet's capabilities newest-first.
create index if not exists agent_wallet_capabilities_agent
    on agent_wallet_capabilities (agent_id, created_at desc);

-- The hot path resolves "is there a live capability for this holder + action?"
-- by (agent, holder_ref) among the not-yet-revoked rows.
create index if not exists agent_wallet_capabilities_holder
    on agent_wallet_capabilities (agent_id, holder_ref)
    where revoked_at is null;

comment on table agent_wallet_capabilities is
    'Scoped, time-boxed, independently-revocable session keys (capabilities) for '
    'autonomous agent wallet spending. Each grant narrows authority to a specific '
    'actor + action(s) + target allowlist + per-use/aggregate USD ceiling + expiry. '
    'Enforced server-side in api/_lib/wallet-capabilities.js, composed with the '
    'wallet-wide policy in api/_lib/agent-trade-guards.js. Owner-managed via the '
    'wallet hub Access tab (/api/agents/:id/solana/capabilities).';

-- Tag custody/spend rows with the capability that authorized them, so the
-- per-capability aggregate ceiling is summed from the SAME ledger that backs the
-- wallet daily ceiling. Additive nullable column — existing rows (and every spend
-- that carried no capability) stay capability_id = NULL and are unaffected.
alter table agent_custody_events
    add column if not exists capability_id uuid;

-- The aggregate-ceiling query sums recent spend rows per capability.
create index if not exists agent_custody_events_capability
    on agent_custody_events (capability_id, created_at)
    where capability_id is not null;

commit;
