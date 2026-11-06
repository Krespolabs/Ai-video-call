-- Migration: remix-royalty settlement + ledger reference on tokenized 3D
-- mints (see api/_lib/tokenize-3d.js). Additive columns only.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260708130000_tokenized_3d_remix_royalty.sql
-- Idempotent.
--
-- remix_royalty:      when this mint names a parent_mint, the REAL on-chain
--                      USDC settlement routed to the parent's creator out of
--                      this mint's x402 fee (api/_lib/remix-royalty.js split
--                      math + api/_lib/remix-settlement.js payout wallet).
--                      null when there is no parent, or nothing was paid
--                      (reason recorded honestly — no parent wallet, sub-dust,
--                      payout unconfigured, or the mint fee was bypassed via
--                      OAuth so there was nothing to split).
-- provenance_ledger:   the agent_actions row this mint's signed provenance was
--                      appended to (api/_lib/asset-provenance.js), so a reader
--                      can cross-check the NFT metadata provenance against the
--                      independently-verifiable ledger entry.

begin;

alter table tokenized_3d_assets
	add column if not exists remix_royalty jsonb,
	add column if not exists provenance_ledger jsonb;

commit;
