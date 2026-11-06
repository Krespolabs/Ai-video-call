begin;

-- PWA & notifications (Road to $1B — task 39).
-- ============================================================================
-- Three new surfaces, all keyed off the existing user_notifications pipeline:
--
--   1. push_subscriptions      — Web Push (VAPID) endpoints per device. One row
--      per browser/device that granted notification permission. Sends fan out
--      from api/_lib/notify.js; dead endpoints (404/410) are pruned on send.
--
--   2. notification_preferences — the unified preference center. One JSONB row
--      per user describing, per category, which channels (in_app/push/email/
--      telegram) are on. Missing keys fall back to code defaults
--      (api/_lib/notify-prefs.js DEFAULTS) so a user with no row gets sensible
--      behaviour and new categories light up without a backfill.
--
--   3. notification_events     — the re-engagement funnel: one row per
--      (notification, channel, event) where event ∈ sent|opened|returned.
--      insertNotification records `sent`; the SW + inbox record `opened`;
--      a push-sourced app open records `returned`. Powers sent→opened→returned
--      analytics so the loop is measured, not guessed.
--
--   4. newsletter_subscribers  — double opt-in marketing list. A POST creates a
--      `pending` row + confirm token (emailed); the confirm link flips it to
--      `confirmed` and adds the contact to the Resend audience. Unsubscribe
--      flips to `unsubscribed` and is honoured on every send.

-- ── 1. push_subscriptions ────────────────────────────────────────────────────
create table if not exists push_subscriptions (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    endpoint     text not null,
    p256dh       text not null,
    auth         text not null,
    user_agent   text,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);
-- One subscription per push endpoint, globally. A re-subscribe upserts (a user
-- can move a device between accounts; the latest owner wins).
create unique index if not exists push_subscriptions_endpoint
    on push_subscriptions (endpoint);
create index if not exists push_subscriptions_user
    on push_subscriptions (user_id, created_at desc);

-- ── 2. notification_preferences ──────────────────────────────────────────────
create table if not exists notification_preferences (
    user_id    uuid primary key references users(id) on delete cascade,
    prefs      jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

-- ── 3. notification_events ───────────────────────────────────────────────────
create table if not exists notification_events (
    id              bigint generated always as identity primary key,
    notification_id uuid references user_notifications(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    channel         text not null check (channel in ('in_app','push','email','telegram')),
    event           text not null check (event in ('sent','opened','returned')),
    meta            jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);
create index if not exists notification_events_notif
    on notification_events (notification_id);
create index if not exists notification_events_funnel
    on notification_events (event, channel, created_at desc);
-- A given notification is "opened"/"returned" at most once per channel — the
-- SW can fire notificationclick more than once across tabs.
create unique index if not exists notification_events_once
    on notification_events (notification_id, channel, event)
    where notification_id is not null and event in ('opened','returned');

-- ── 4. newsletter_subscribers ────────────────────────────────────────────────
create table if not exists newsletter_subscribers (
    id            uuid primary key default gen_random_uuid(),
    email         citext not null unique,
    status        text not null default 'pending'
                  check (status in ('pending','confirmed','unsubscribed')),
    confirm_token text not null,
    locale        text,
    source        text,
    created_at    timestamptz not null default now(),
    confirmed_at  timestamptz,
    unsubbed_at   timestamptz
);
create index if not exists newsletter_subscribers_token
    on newsletter_subscribers (confirm_token);

commit;
