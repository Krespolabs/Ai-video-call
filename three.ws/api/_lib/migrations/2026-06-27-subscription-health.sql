-- Migration: x402 Subscription Status Health Check value sink.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-06-27-subscription-health.sql
-- Idempotent.
--
-- Backs the `subscription-status-health-check` autonomous-registry entry
-- (api/_lib/x402/pipelines/subscription-health.js). The daily pipeline enumerates
-- every x402 subscription, classifies it (active | expiring_soon | expired |
-- revoked), emails subscribers 7 days before expiry, and upserts one verdict row
-- per subscription here.
--
-- Downstream consumer: the admin subscription-management surface reads this to
-- badge expiring/expired keys, and ops alerting watches
-- WHERE status IN ('expired','expiring_soon') to catch a lapse before a partner's
-- integration breaks. The pipeline also ensures this schema at runtime; this file
-- documents and pre-provisions it.

create table if not exists x402_subscription_health (
    subscription_id       text primary key,
    name                  text,
    key_prefix            text,
    status                text not null,            -- active | expiring_soon | expired | revoked
    rate_limit_per_minute integer,
    expires_at            timestamptz,
    revoked_at            timestamptz,
    days_to_expiry        integer,                  -- null when no expiry
    contact_email         text,
    notified_expiry_at    timestamptz,              -- the expires_at value we last emailed about
    notified_at           timestamptz,              -- when that warning email was sent
    last_checked_at       timestamptz not null default now(),
    run_id                uuid,
    meta                  jsonb
);

create index if not exists x402_subscription_health_status_idx
    on x402_subscription_health (status, expires_at);
