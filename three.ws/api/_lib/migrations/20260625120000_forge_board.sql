-- Forge-Off — community curation layer over forge_creations.
--
-- /forge already persists every text→3D generation (forge_creations) and serves
-- a chronological "Fresh from the Forge" showcase. This migration adds the one
-- thing no three.ws surface had: community curation by VOTES. It turns the
-- passive newest-first feed into a ranked board with a weekly ritual
-- ("Forge-Off") and a permanent hall of champions.
--
-- Three pieces:
--   1. forge_creations.vote_count — denormalized tally, maintained on every
--      vote/unvote from the authoritative forge_votes table (recomputed via a
--      correlated subquery so it can never drift). Cheap to ORDER BY.
--   2. forge_votes — one row per (creation, anonymous voter). The voter is the
--      same hashed browser-local id (x-forge-client) the gallery already scopes
--      by, so voting needs no login — consistent with /forge being auth-free.
--   3. forge_board_winners — the crowned top creation for each past Forge-Off
--      week (Monday→Monday UTC), written once by the weekly cron so the hall of
--      fame is stable even after later votes shuffle the live board.

ALTER TABLE forge_creations
	ADD COLUMN IF NOT EXISTS vote_count integer NOT NULL DEFAULT 0;

-- One vote per anonymous browser per creation. voter_key = sha256 of the
-- browser-local forge id (api/_lib/forge-store.js hashClient); ip_hash is for
-- abuse triage only. ON DELETE CASCADE so removing a creation clears its votes.
CREATE TABLE IF NOT EXISTS forge_votes (
	creation_id   uuid NOT NULL REFERENCES forge_creations(id) ON DELETE CASCADE,
	voter_key     text NOT NULL,
	ip_hash       text,
	created_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (creation_id, voter_key)
);

-- "Has this voter already upvoted these creations?" — the board read resolves a
-- per-row `voted` flag for the requesting browser across a page of cards.
CREATE INDEX IF NOT EXISTS idx_forge_votes_voter
	ON forge_votes (voter_key, creation_id);

-- Abuse triage: surface a single ip carpeting votes across many creations.
CREATE INDEX IF NOT EXISTS idx_forge_votes_ip
	ON forge_votes (ip_hash, created_at DESC)
	WHERE ip_hash IS NOT NULL;

-- The board ranking: most-voted, newest-first, over the public (done, stored,
-- not-discarded) creations the showcase already qualifies. Partial so the index
-- only carries board-eligible rows.
CREATE INDEX IF NOT EXISTS idx_forge_creations_board
	ON forge_creations (vote_count DESC, created_at DESC)
	WHERE status = 'done' AND glb_url IS NOT NULL;

-- Permanent hall of fame: the winning creation for each completed Forge-Off
-- week. Keyed by the week's Monday 00:00 UTC. The creation columns are
-- denormalized at crowning time so a winner card still renders even if the row
-- is later discarded or pruned (creation_id then nulls via ON DELETE SET NULL).
CREATE TABLE IF NOT EXISTS forge_board_winners (
	week_start          date PRIMARY KEY,
	creation_id         uuid REFERENCES forge_creations(id) ON DELETE SET NULL,
	votes               integer NOT NULL DEFAULT 0,
	prompt              text,
	glb_url             text,
	preview_image_url   text,
	model_category      text,
	crowned_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forge_board_winners_recent
	ON forge_board_winners (week_start DESC);
