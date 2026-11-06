-- Migration: APNs device tokens for the three.ws iOS app.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260930160000_apns_devices.sql
-- Idempotent.
--
-- The iOS app's WKWebView runs no service worker, so Web Push (push_subscriptions)
-- cannot reach it. The app registers with Apple Push Notification service
-- instead and hands its device token to POST /api/push/device, which stores it
-- here. api/_lib/notify.js fans every push-enabled notification out to both
-- tables, so the preference center governs the iPhone exactly as it governs a
-- browser.
--
--   token        the hex device token APNs issued. Unique globally: a phone
--                that signs into another account moves to that account, the
--                same latest-owner-wins rule push_subscriptions uses.
--   environment  which APNs host accepts the token. A development build is
--                issued sandbox tokens and an App Store or TestFlight build
--                production ones; the client cannot tell which it is, so the
--                sender tries the recorded host, falls back to the other on
--                BadDeviceToken, and records whichever one answered.
--
-- api/push/device.js writes rows; api/_lib/apns.js reads them and prunes the
-- ones APNs reports as gone.

begin;

create table if not exists apns_devices (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    token        text not null,
    environment  text not null default 'production'
                 check (environment in ('production', 'sandbox')),
    app_version  text,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create unique index if not exists apns_devices_token
    on apns_devices (token);
create index if not exists apns_devices_user
    on apns_devices (user_id, last_seen_at desc);

comment on table apns_devices is
    'APNs device tokens for the iOS app, one row per device, latest owner wins.';

commit;
