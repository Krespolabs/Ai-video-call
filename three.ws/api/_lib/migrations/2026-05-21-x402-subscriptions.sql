-- Migration: x402 subscription API keys + access bypass audit trail.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-05-21-x402-subscriptions.sql
-- Idempotent.
--
-- USE-23 wiring: api/_lib/x402/api-keys.js + api/_lib/x402/access-control.js
-- read/write these tables. The onProtectedRequest hook installed by
-- installAccessControl() short-circuits the 402 challenge when a request
-- carries either INTERNAL_API_KEY (env), a subscription key (this table),
-- or an OAuth bearer with the route's required scope. Every bypass — and
-- every abort (invalid key, expired, rate-limited) — writes one row to
-- x402_access_log so USE-24 audit dashboards can reconstruct who used
-- which endpoint without paying.

create table if not exists x402_subscriptions (
    id              text primary key,                       -- short id, surfaced in access-log captions
    name            text not null,                          -- human-readable label (e.g. "Partner Acme")
    key_hash        text not null unique,                   -- sha256(plaintext key); plaintext shown once at creation
    key_prefix      text not null,                          -- "x402_live_<6char>" for UI display + log correlation
    rate_limit_per_minute integer not null default 60,      -- sliding-window cap per route
    expires_at      timestamptz,                            -- null = no expiry
    revoked_at      timestamptz,                            -- null = active
    meta            jsonb,                                  -- contact, tier, notes — never PII required for billing
    created_by      uuid references users(id) on delete set null,
    created_at      timestamptz not null default now()
);

create index if not exists x402_subscriptions_prefix_idx on x402_subscriptions(key_prefix);
create index if not exists x402_subscriptions_active_idx on x402_subscriptions(revoked_at, expires_at);

create table if not exists x402_access_log (
    id          uuid primary key default gen_random_uuid(),
    caller_id   text not null,        -- 'internal' | 'subscription:<id>' | 'oauth:<sub>' | 'abort:<reason>'
    route       text not null,        -- e.g. '/api/x402/model-check'
    reason      text not null,        -- short tag — full context in meta
    granted     boolean not null,     -- true = bypass granted, false = denied (abort)
    meta        jsonb,                -- ip, ua, requiredScope, etc.
    created_at  timestamptz not null default now()
);

create index if not exists x402_access_log_caller_idx on x402_access_log(caller_id, created_at desc);
create index if not exists x402_access_log_route_idx on x402_access_log(route, created_at desc);
create index if not exists x402_access_log_created_idx on x402_access_log(created_at desc);
