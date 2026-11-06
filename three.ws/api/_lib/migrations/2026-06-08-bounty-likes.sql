-- Submission upvotes ("likes") for the /go bounty board.
--
-- Pure social-proof layer: one row per (submission, user). Counts are computed
-- on read (see api/_lib/bounty-likes.js) rather than denormalised, so this
-- migration only adds a table and never alters bounty_submissions — the board
-- keeps working even if this hasn't been applied yet (enrichment degrades to
-- zero likes).

CREATE TABLE IF NOT EXISTS bounty_submission_likes (
  submission_id UUID        NOT NULL REFERENCES bounty_submissions(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (submission_id, user_id)
);

CREATE INDEX IF NOT EXISTS bsl_submission_idx ON bounty_submission_likes(submission_id);
CREATE INDEX IF NOT EXISTS bsl_user_idx       ON bounty_submission_likes(user_id);
