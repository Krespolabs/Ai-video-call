-- Per-wallet cursor for the general on-chain leak/outbound scanner
-- (api/cron/wallets-leak-scan.js).
--
-- The ring leak scanner (api/cron/x402-ring-leak-scan.js) only watches the x402
-- ring role wallets + x402_ring_wallets registry — a SUBSET of the wallets the
-- platform controls. The general scanner closes that gap: it watches EVERY
-- resolvable SOLANA_SIGNERS mainnet wallet (economy master, coin-launcher master,
-- platform/coin/club/buyback/circulation treasuries, x402 sponsor/payer, …) and
-- alarms if SOL or a non-fee token debit ever leaves one of them to an address
-- outside the controlled-wallet universe (ringAllowedAddresses()).
--
-- This table is the scanner's resumption cursor — one row per wallet, mirroring
-- x402_ring_scan_cursor — so getSignaturesForAddress stays bounded (only sigs
-- newer than last_signature are fetched) and every transaction is classified
-- exactly once. It holds NO secrets and NO balances; just the last-seen signature
-- and running counters. The scanner also creates it lazily on first run
-- (ensureSchema), so a fresh env works whether this migration is applied ahead of
-- time or not.

CREATE TABLE IF NOT EXISTS wallet_scan_cursor (
    wallet          text PRIMARY KEY,       -- the controlled wallet's base58 pubkey
    wallet_name     text,                   -- its SOLANA_SIGNERS name (for the board / alerts)
    last_signature  text,                   -- newest signature already classified
    last_slot       bigint,
    scanned_total   bigint      NOT NULL DEFAULT 0,
    leaks_total     bigint      NOT NULL DEFAULT 0,
    last_run_id     uuid,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_scan_cursor_updated_idx
    ON wallet_scan_cursor (updated_at DESC);
