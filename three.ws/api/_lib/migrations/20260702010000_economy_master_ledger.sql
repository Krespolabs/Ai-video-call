-- Tamper-evident accounting ledger for the economy master funding wallet
-- (api/_lib/economy-master.js, WwwuGbq…T3WwW). One append-only, hash-chained row
-- per money event: every SOL transfer the master makes, every blocked/failed
-- attempt, and a per-sweep heartbeat summary. This is the platform's financial
-- book of record for the funding root — retained for accounting, breach
-- forensics, and regulatory review.
--
-- Tamper-evidence: each row carries prev_hash + entry_hash forming a SHA-256 hash
-- chain (same shape as reasoning-ledger / ledger-anchor). Editing or deleting any
-- historical row breaks the chain from that point forward; economy-ledger.js
-- verifyChain() and the economy-reconcile cron detect the break. The chain head
-- can be anchored on-chain for third-party-verifiable timestamps.
--
-- Writer:    api/_lib/economy-ledger.js (via api/cron/treasury-topup.js)
-- Verifier:  api/cron/economy-reconcile.js (chain-of-custody + on-chain match)
-- Export:    scripts/economy-ledger-export.mjs (accounting CSV/JSON)
--
-- The writer also creates this table lazily (ensureSchema); this migration is
-- belt-and-suspenders so a fresh env has it whether applied ahead or on first run.

CREATE TABLE IF NOT EXISTS economy_master_ledger (
    id                bigserial   PRIMARY KEY,
    seq               bigint      NOT NULL,             -- per-wallet monotonic chain position
    ts                timestamptz NOT NULL,             -- the exact instant hashed into entry_hash
    run_id            uuid,                             -- the sweep that produced this row
    master_pubkey     text        NOT NULL,
    event             text        NOT NULL,             -- 'transfer' | 'blocked' | 'failed' | 'sweep'
    target_name       text,                             -- engine signer name (null on sweep summary)
    target_pubkey     text,
    lamports          bigint,                           -- movement size (null on non-transfer rows)
    sol               numeric(20,9),
    sol_usd           numeric(20,6),                    -- SOL/USD at write time (accounting valuation)
    usd_value         numeric(20,6),                    -- sol * sol_usd captured at time of movement
    tx_signature      text,                             -- confirmed transfer signature (transfer rows)
    reason            text,                             -- blocked/failed reason code
    master_sol_before numeric(20,9),
    master_sol_after  numeric(20,9),
    reserve_sol       numeric(20,9),
    run_cap_sol       numeric(20,9),
    per_topup_max_sol numeric(20,9),
    network           text        NOT NULL DEFAULT 'mainnet',
    detail            jsonb,
    prev_hash         text,                             -- entry_hash of the previous row for this master
    entry_hash        text        NOT NULL              -- sha256 over the canonical row + prev_hash
);

-- One chain per master wallet: seq is unique and gapless per pubkey.
CREATE UNIQUE INDEX IF NOT EXISTS economy_master_ledger_seq_idx
    ON economy_master_ledger (master_pubkey, seq);
CREATE INDEX IF NOT EXISTS economy_master_ledger_ts_idx
    ON economy_master_ledger (ts DESC);
CREATE INDEX IF NOT EXISTS economy_master_ledger_sig_idx
    ON economy_master_ledger (tx_signature);
CREATE INDEX IF NOT EXISTS economy_master_ledger_event_idx
    ON economy_master_ledger (event, ts DESC);
