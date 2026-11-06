-- Migration: avatar thumbnail regeneration pipeline (x402 autonomous loop).
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-06-27-avatar-thumbnail-regen.sql
-- Idempotent.
--
-- The autonomous x402 spend loop (api/cron/x402-autonomous-loop.js) periodically
-- pays /api/x402/asset-download for the stalest marketplace listing, then queues
-- a thumbnail re-render. The drainer cron (api/cron/avatar-thumbnail-render.js)
-- renders the current GLB to a fresh PNG and writes it back so listings always
-- show the model's current appearance.
--
-- Two pieces of state:
--   1. Freshness columns on paid_assets so the selector can find stale listings.
--   2. avatar_thumbnail_regen_jobs — the queue the autonomous loop fills and the
--      drainer cron consumes.

-- ── paid_assets freshness tracking ──────────────────────────────────────────
-- thumbnail_r2_key       R2 object key of the current rendered thumbnail (null = never rendered).
-- thumbnail_generated_at when the current thumbnail was rendered (null = never).
-- source_updated_at      when the underlying GLB bytes last changed; if this is
--                        newer than thumbnail_generated_at the thumbnail is stale.
-- avatar_id              link back to the avatars row so a regen also refreshes
--                        the avatar's marketplace thumbnail_key.
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS thumbnail_r2_key       text;
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS thumbnail_generated_at timestamptz;
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS source_updated_at      timestamptz;
ALTER TABLE paid_assets ADD COLUMN IF NOT EXISTS avatar_id              uuid REFERENCES avatars(id) ON DELETE SET NULL;

-- ── avatar_thumbnail_regen_jobs ─────────────────────────────────────────────
-- One row per regen the autonomous loop triggers. The loop inserts status
-- 'queued' after a successful paid asset-download; the drainer cron renders and
-- moves it to 'done' (or 'failed' with the error and an incremented attempt
-- count). r2_key is the SOURCE GLB key — the drainer re-presigns it at render
-- time (the loop's presigned downloadUrl is short-lived and would expire before
-- the drainer runs).
CREATE TABLE IF NOT EXISTS avatar_thumbnail_regen_jobs (
  id                 bigserial   PRIMARY KEY,
  asset_id           uuid        REFERENCES paid_assets(id) ON DELETE CASCADE,
  asset_slug         text        NOT NULL,
  avatar_id          uuid        REFERENCES avatars(id) ON DELETE SET NULL,
  r2_key             text        NOT NULL,
  run_id             uuid,
  x402_tx_signature  text,
  amount_atomic      bigint      NOT NULL DEFAULT 0,
  status             text        NOT NULL DEFAULT 'queued'
                                 CHECK (status IN ('queued','rendering','done','failed')),
  thumbnail_r2_key   text,
  width              int         NOT NULL DEFAULT 768,
  height             int         NOT NULL DEFAULT 768,
  attempts           int         NOT NULL DEFAULT 0,
  error              text,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  rendered_at        timestamptz
);

-- Drainer pulls oldest queued / retryable-failed rows first.
CREATE INDEX IF NOT EXISTS avatar_thumbnail_regen_jobs_status_idx
  ON avatar_thumbnail_regen_jobs (status, created_at);

-- At most one open (queued/rendering) job per asset — the loop checks this before
-- enqueuing so a slow drainer never lets duplicates pile up for one listing.
CREATE UNIQUE INDEX IF NOT EXISTS avatar_thumbnail_regen_jobs_open_uniq
  ON avatar_thumbnail_regen_jobs (asset_slug)
  WHERE status IN ('queued','rendering');
