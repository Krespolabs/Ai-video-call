-- Case-insensitive username lookup index for the login/signup hot path.
-- api/auth/[action].js matches on lower(display_name) = lower($1); without this
-- index every non-email login attempt sequentially scans users — a trivial DoS
-- amplifier as the table grows.
--
-- CONCURRENTLY: users is auth-critical and must not be write-locked during the
-- build. CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this file
-- intentionally has NO begin/commit wrapper and contains only this statement.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260621123000_users-display-name-index.sql

create index concurrently if not exists users_display_name_lower
    on users (lower(display_name)) where deleted_at is null;
