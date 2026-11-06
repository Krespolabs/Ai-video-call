-- Bounty board tables for /go
-- Run once against the Neon Postgres database:
--   psql $DATABASE_URL -f scripts/migrate-bounties.sql

CREATE TABLE IF NOT EXISTS bounties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  username      TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  coin_symbol   TEXT NOT NULL DEFAULT '$THREE',
  coin_mint     TEXT NOT NULL DEFAULT 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
  reward_sol    NUMERIC(18,9),
  reward_tokens NUMERIC(30,0),
  reward_usd    NUMERIC(10,2),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolving','closed')),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  submission_count INTEGER NOT NULL DEFAULT 0,
  winner_submission_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bounties_status_idx  ON bounties(status)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bounties_user_idx    ON bounties(user_id)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bounties_created_idx ON bounties(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bounties_subs_idx    ON bounties(submission_count DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS bounty_submissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id   UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  username    TEXT,
  content     TEXT,
  media_url   TEXT,
  media_type  TEXT CHECK (media_type IN ('image','video','link')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  reward_sol  NUMERIC(18,9),
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bs_bounty_idx  ON bounty_submissions(bounty_id);
CREATE INDEX IF NOT EXISTS bs_user_idx    ON bounty_submissions(user_id);
CREATE INDEX IF NOT EXISTS bs_created_idx ON bounty_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS bs_status_idx  ON bounty_submissions(status);

-- Submission upvotes ("likes"). Counts are computed on read; one row per
-- (submission, user). See api/_lib/bounty-likes.js and the dated migration
-- api/_lib/migrations/2026-06-08-bounty-likes.sql (the canonical runner path).
CREATE TABLE IF NOT EXISTS bounty_submission_likes (
  submission_id UUID        NOT NULL REFERENCES bounty_submissions(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (submission_id, user_id)
);

CREATE INDEX IF NOT EXISTS bsl_submission_idx ON bounty_submission_likes(submission_id);
CREATE INDEX IF NOT EXISTS bsl_user_idx       ON bounty_submission_likes(user_id);
