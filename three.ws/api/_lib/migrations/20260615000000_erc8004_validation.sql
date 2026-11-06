-- ERC-8004 ValidationRegistry attestation cache.
--
-- The authoritative record lives on-chain (ValidationRegistry.getLatestByKind);
-- these columns mirror the latest glb-schema attestation so list views, the
-- crawler, and ops dashboards can show a "Validated" badge and re-validation
-- state without an RPC round-trip per row. The on-chain read path stays the
-- source of truth for the profile badge.

ALTER TABLE erc8004_agents_index
  ADD COLUMN IF NOT EXISTS validation_passed     boolean,
  ADD COLUMN IF NOT EXISTS validation_kind       text,
  ADD COLUMN IF NOT EXISTS validation_proof_hash text,
  ADD COLUMN IF NOT EXISTS validation_proof_uri  text,
  ADD COLUMN IF NOT EXISTS validation_tx         text,
  ADD COLUMN IF NOT EXISTS validator_address     text,
  ADD COLUMN IF NOT EXISTS validation_at         timestamptz,
  -- Last ops error code (e.g. validator_not_allowlisted) when an attestation
  -- could not be recorded — visible to ops, never blocks registration.
  ADD COLUMN IF NOT EXISTS validation_error      text;

-- Fast lookup of validated agents for directory filtering / badges.
CREATE INDEX IF NOT EXISTS idx_erc8004_validation_passed
  ON erc8004_agents_index (chain_id, agent_id)
  WHERE validation_passed = true;
