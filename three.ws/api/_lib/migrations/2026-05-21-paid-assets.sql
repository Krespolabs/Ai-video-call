-- Migration: paid_assets catalog for /api/x402/asset-download.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-05-21-paid-assets.sql
-- Idempotent.
--
-- Canonical "buy once, re-download forever" 3D-asset bazaar: creators upload a
-- GLB / avatar / accessory to R2, price it in USDC atomics, and the asset is
-- served via the SIWX-enabled asset-download endpoint. Per-row payout overrides
-- let creators receive USDC directly to their own wallet; when NULL the global
-- env.X402_PAY_TO_* fallbacks apply (handled in api/_lib/x402-paid-endpoint.js).

CREATE TABLE IF NOT EXISTS paid_assets (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text        NOT NULL UNIQUE,
  title                text        NOT NULL,
  description          text        NOT NULL,
  mime_type            text        NOT NULL,
  size_bytes           bigint      NOT NULL,
  r2_key               text        NOT NULL,
  price_atomics        text        NOT NULL,
  creator_payto_base   text,
  creator_payto_solana text,
  creator_payto_bsc    text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paid_assets_slug_idx ON paid_assets (slug);
