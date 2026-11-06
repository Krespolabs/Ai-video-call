begin;

-- Referral activation rewards + virality funnel instrumentation
-- =============================================================
-- The referral system already attributes signups (users.referred_by_id) and
-- accrues purchase commission (users.referral_earnings_total). This migration
-- adds the two missing halves of a real viral loop:
--
--   1. ACTIVATION — a single, idempotent "first win" timestamp per user, so the
--      growth funnel can measure who actually reached value, and so a referral
--      can reward BOTH sides the moment a referred user activates (not only when
--      they later spend). The reward itself is paid as platform credits via the
--      existing credit ledger (api/_lib/credits.js, kind='grant',
--      ref_type='referral_activation') — no new balance table needed.
--
--   2. VISITS — share/referral-link visits, the top of the funnel. Without these
--      the loop's k-factor (signups per sharing user) is unmeasurable. We store a
--      deduped, NON-PII row per (code, hashed-visitor, UTC day) so a single
--      visitor refreshing a link inflates nothing.

-- ── Activation timestamp ───────────────────────────────────────────────────────
-- NULL until the user's first qualifying win (first avatar/3D creation). Set
-- exactly once by api/_lib/activation.js via a `WHERE activated_at IS NULL` guard,
-- so the activation event + referral reward fire a single time per account.
alter table users add column if not exists activated_at timestamptz;

-- Partial index: funnel queries only ever scan activated users, and the set of
-- activated accounts is far smaller than the full users table early on.
create index if not exists users_activated_at_idx
	on users (activated_at)
	where activated_at is not null;

-- Referred-and-activated funnel slice (signup→activation conversion by referrer).
create index if not exists users_referred_activated_idx
	on users (referred_by_id, activated_at)
	where referred_by_id is not null;

-- ── Referral-link visits (top of funnel) ───────────────────────────────────────
-- One row per (code, visitor, day). `visitor_hash` is sha256(ip + ua + code) —
-- never raw IP/UA — so we can dedup and rate-shape without storing PII. The
-- referrer is resolved at write time when the code matches a live user; an
-- unknown/garbage code still records a visit (referrer_user_id NULL) so we can
-- see traffic on dead links too. `day` is the UTC date the writer computes, kept
-- as a real column (not a function index) so the dedup unique index is immutable.
create table if not exists referral_visits (
	id                bigserial primary key,
	code              text not null,
	referrer_user_id  uuid references users(id) on delete set null,
	visitor_hash      text not null,
	day               date not null,
	created_at        timestamptz not null default now()
);

-- Dedup: a given visitor counts once per code per day. Writers use
-- ON CONFLICT DO NOTHING so a refresh/replay is a silent no-op.
create unique index if not exists referral_visits_dedup
	on referral_visits (code, visitor_hash, day);

-- Funnel rollups read visits by referrer over a time window, and by code.
create index if not exists referral_visits_referrer_time_idx
	on referral_visits (referrer_user_id, created_at desc);
create index if not exists referral_visits_code_time_idx
	on referral_visits (code, created_at desc);

commit;
