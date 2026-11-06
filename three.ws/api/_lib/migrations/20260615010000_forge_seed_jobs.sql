-- forge_seed_jobs: tracks AI auto-seeded 3D generations so the per-minute cron
-- can poll in-flight jobs across invocations and attribute each finished model
-- to the synthetic user account that "owns" it.

CREATE TABLE IF NOT EXISTS forge_seed_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,          -- synthetic users.id
    raw_client_id   text NOT NULL,          -- UUID sent as x-forge-client header
    job_id          text NOT NULL,          -- forge job token (for ?job= polling)
    prompt          text NOT NULL,
    model_category  text NOT NULL DEFAULT 'avatar',
    creation_id     uuid,                   -- forge_creations.id (set when done)
    status          text NOT NULL DEFAULT 'pending', -- pending | done | failed
    glb_url         text,
    error           text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS forge_seed_jobs_status_idx
    ON forge_seed_jobs (status, started_at);
