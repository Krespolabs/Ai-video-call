-- Fix referral_earnings_total column type: DECIMAL(12,2) → BIGINT.
--
-- The column stores atomic USDC units (6-decimal integers), written by
-- api/_lib/referrals.js creditReferralCommission:
--
--   UPDATE users
--   SET referral_earnings_total = COALESCE(referral_earnings_total, 0) + <atomics>
--
-- and read back as an integer by getMembershipCard and getReferredUsers.
-- DECIMAL(12,2) has a maximum integer magnitude of 10 digits (9,999,999,999),
-- which equals only $9,999.99 in atomic USDC units. A referrer earning more
-- than ~$10k overflows silently.
--
-- BIGINT (8-byte signed, max ~9.2 × 10^18) safely stores lifetime earnings
-- up to ~$9.2 trillion in atomics — effectively unbounded for this use case.
-- The existing DEFAULT 0.00 becomes DEFAULT 0; any stored decimal values
-- (they will all be whole numbers since the writer never fractionalises atomics)
-- are preserved exactly.
--
-- Wrapped in a transaction because ALTER COLUMN TYPE on a live table takes a
-- brief ACCESS EXCLUSIVE lock. On Postgres 14+ this is fast when no rewrite is
-- needed (integer coercion of whole-number DECIMAL requires no rewrite).

BEGIN;

ALTER TABLE users
    ALTER COLUMN referral_earnings_total
    TYPE BIGINT
    USING ROUND(referral_earnings_total)::BIGINT;

ALTER TABLE users
    ALTER COLUMN referral_earnings_total
    SET DEFAULT 0;

COMMIT;
