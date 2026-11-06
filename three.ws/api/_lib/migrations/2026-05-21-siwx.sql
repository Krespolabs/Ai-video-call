-- Migration: Sign-In-With-X (SIWX, CAIP-122) payment-history + nonce tables.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-05-21-siwx.sql
-- Idempotent.
--
-- These tables back the SIWxStorage adapter used by paidEndpoint(): a wallet
-- that has paid for a resource can re-access it by signing a CAIP-122 message
-- instead of paying again. Stored addresses follow the CAIP-122 payload exactly:
-- lowercase hex for EVM (`eip155:*`), Base58 for Solana (`solana:*`). The
-- adapter in api/_lib/siwx-storage.js normalizes before SELECT/INSERT — no CHECK
-- constraint here, since the canonical form differs by chain.

CREATE TABLE IF NOT EXISTS siwx_payments (
  resource     text        NOT NULL,
  address      text        NOT NULL,
  network      text        NOT NULL,
  paid_at      timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  use_count    integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (resource, address)
);

CREATE INDEX IF NOT EXISTS siwx_payments_expires_idx
  ON siwx_payments (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS siwx_nonces (
  nonce    text        PRIMARY KEY,
  resource text        NOT NULL,
  address  text        NOT NULL,
  used_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS siwx_nonces_used_at_idx
  ON siwx_nonces (used_at);
