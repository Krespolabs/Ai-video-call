-- Forge creations — durable text→3D generations + the data flywheel signal.
--
-- The /forge pipeline (flux-schnell reference image → Microsoft TRELLIS mesh)
-- previously returned the ephemeral Replicate delivery URL and forgot the job.
-- Those URLs expire in ~1h, so generated models evaporated and nothing about
-- the (prompt → image → mesh → human verdict) loop was retained.
--
-- This table is the proprietary data engine: one row per generation, the GLB +
-- reference image copied into our own object storage so they're permanent, and
-- the human outcome (kept / discarded / downloaded) captured as the training
-- signal that lets the in-house model eventually beat the open weights it forks.
--
-- Auth-free by design: /forge has no login, so creations are scoped to a stable
-- anonymous client key (a hashed browser-local id) rather than a user_id.

CREATE TABLE IF NOT EXISTS forge_creations (
	id                   uuid PRIMARY KEY,
	client_key           text NOT NULL,          -- sha256 of the browser-local anon id
	ip_hash              text,                   -- sha256 of client ip (abuse triage only)
	prompt               text NOT NULL,
	aspect               text,                   -- reference-image aspect ratio (1:1, 4:3, …)
	preview_image_url    text,                   -- durable reference image (our CDN) when copied
	preview_key          text,                   -- object-storage key for the reference image
	replicate_job_id     text,                   -- TRELLIS prediction id (poll correlation)
	text_to_image_model  text,                   -- e.g. black-forest-labs/flux-schnell
	glb_key              text,                   -- object-storage key for the durable mesh
	glb_url              text,                   -- durable public CDN url for the mesh
	size_bytes           integer,
	status               text NOT NULL DEFAULT 'generating', -- generating | done | failed
	outcome              text NOT NULL DEFAULT 'generated',  -- generated | accepted | rejected
	downloaded           boolean NOT NULL DEFAULT false,
	rating               smallint,               -- optional 1–5 quality signal
	note                 text,                   -- optional free-text feedback
	error                text,
	created_at           timestamptz NOT NULL DEFAULT now(),
	updated_at           timestamptz NOT NULL DEFAULT now(),
	feedback_at          timestamptz
);

-- Gallery: newest creations for a given anonymous client.
CREATE INDEX IF NOT EXISTS idx_forge_creations_client
	ON forge_creations (client_key, created_at DESC);

-- Poll correlation: forge.js looks a row up by its TRELLIS prediction id.
CREATE INDEX IF NOT EXISTS idx_forge_creations_job
	ON forge_creations (replicate_job_id);

-- Flywheel export: pull the labeled (kept vs discarded) training pairs.
CREATE INDEX IF NOT EXISTS idx_forge_creations_outcome
	ON forge_creations (outcome, created_at DESC)
	WHERE status = 'done';
