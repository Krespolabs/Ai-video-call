-- Per-skill ratings & reviews for paid skills sold on an agent.
--
-- Distinct from:
--   • agent_reviews   — one rating per (agent, user) for the agent as a whole.
--   • skill_ratings   — ratings for installable marketplace_skills templates.
--
-- skill_reviews captures social proof for an *individual paid skill* on a
-- specific agent (the (agent_id, skill) pair that agent_skill_prices /
-- skill_purchases are keyed on). Only a user who has actually obtained access
-- to that skill — a confirmed purchase, time-pass, subscription or trial — may
-- leave a review; the API enforces that with hasSkillAccess before insert.
--
-- One review per (agent_id, skill, reviewer); POST upserts in place. Indexes
-- support the two hot paths: per-skill aggregation (avg + count + recent list)
-- and "has this reviewer already reviewed this skill?".
--
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260621180000_skill_reviews.sql
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS skill_reviews (
	id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
	agent_id    uuid        NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
	skill       text        NOT NULL,
	reviewer_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	rating      smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
	body        text,
	created_at  timestamptz NOT NULL DEFAULT now(),
	updated_at  timestamptz NOT NULL DEFAULT now(),
	UNIQUE (agent_id, skill, reviewer_id)
);

-- Per-skill aggregation (AVG(rating), COUNT(*), recent-first list).
CREATE INDEX IF NOT EXISTS skill_reviews_agent_skill
	ON skill_reviews (agent_id, skill, created_at DESC);

-- "Which skills has this user reviewed?" / fast reviewer lookups.
CREATE INDEX IF NOT EXISTS skill_reviews_reviewer
	ON skill_reviews (reviewer_id);

-- Auto-bump updated_at on upsert/edit; reuse the standard trigger function.
DO $$ BEGIN
	CREATE TRIGGER skill_reviews_set_updated_at BEFORE UPDATE ON skill_reviews
		FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
