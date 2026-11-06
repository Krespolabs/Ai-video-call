-- Functional index on UPPER(referral_code) for case-insensitive referral lookups.
--
-- Every hot query on the referral system matches on UPPER(referral_code) = $code:
--   • api/users/referral-claim.js        — attribute a referral at claim time
--   • api/_lib/referrals.js              — getReferralCodeAvailability, setReferralCode
--   • api/auth/[action].js              — resolve referrer at email signup
--   • api/marketplace/purchase.js        — resolve referrer at purchase
--   • api/marketplace/buy-asset.js       — resolve referrer at asset purchase
--
-- Without a functional index, PostgreSQL cannot use the plain B-tree index on
-- the raw referral_code column for these queries and falls back to a sequential
-- scan on users — a full table scan on every referral lookup.
--
-- The existing UNIQUE constraint (from 001_add_referrals.sql) stays in place. It
-- enforces exact-case uniqueness on the stored value, which is fine because all
-- codes are stored UPPERCASE by the application. This functional index is an
-- additional performance index only.
--
-- CONCURRENTLY: users is auth-critical and must not be write-locked during the
-- build. CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this file
-- intentionally has NO begin/commit wrapper and contains only this statement.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260621210000_referral_code_upper_index.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_referral_code_upper
    ON users (UPPER(referral_code))
    WHERE deleted_at IS NULL;
