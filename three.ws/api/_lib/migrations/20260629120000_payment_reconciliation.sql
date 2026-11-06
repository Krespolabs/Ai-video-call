-- Payment Revenue Reconciliation (USE-027, Finance)
--
-- Backs the `revenue-reconciliation` autonomous-registry entry
-- (api/_lib/x402/revenue-reconciliation.js). Each daily run cross-checks every
-- settlement our books claim — outbound x402_autonomous_log paid rows and inbound
-- agent_payment_intents — against the actual on-chain transaction, and upserts one
-- verdict row per record here keyed on (source, source_ref).
--
-- A row with reconciled = false is a financial-integrity alert: the DB recorded a
-- settlement the chain does not corroborate (no tx on-chain, tx reverted, or no
-- signature was kept). The ops financial-integrity surface reads
-- `... WHERE reconciled = false` to flag these before they corrupt accounting.
--
-- Mirrors the in-code ensureSchema() in revenue-reconciliation.js so a fresh env
-- works whether migrations are applied ahead of time or lazily on first run.

CREATE TABLE IF NOT EXISTS payment_reconciliation (
    id            bigserial   PRIMARY KEY,
    source        text        NOT NULL,          -- 'autonomous_log' | 'payment_intent'
    source_ref    text        NOT NULL,          -- row id within that book
    tx_signature  text,
    network       text,
    amount_atomic bigint,
    db_status     text        NOT NULL,          -- what the book claims
    chain_status  text        NOT NULL,          -- confirmed|failed_onchain|missing_onchain|missing_signature|skipped_non_solana|unknown
    reconciled    boolean     NOT NULL,
    discrepancy   text,                          -- null when reconciled
    detail        jsonb,
    run_id        uuid,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    checked_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_ref)
);

CREATE INDEX IF NOT EXISTS payment_reconciliation_open_idx
    ON payment_reconciliation (checked_at DESC) WHERE reconciled = false;
CREATE INDEX IF NOT EXISTS payment_reconciliation_sig_idx
    ON payment_reconciliation (tx_signature);

-- The autonomous log is created lazily by api/cron/x402-autonomous-loop.js on
-- first run; mirror its canonical definition here so this migration is
-- self-contained on a fresh env (matches the file header's intent). Idempotent.
CREATE TABLE IF NOT EXISTS x402_autonomous_log (
    id              bigserial PRIMARY KEY,
    run_id          uuid NOT NULL,
    ts              timestamptz DEFAULT now(),
    endpoint_type   text NOT NULL CHECK (endpoint_type IN ('self', 'external')),
    service_name    text NOT NULL,
    endpoint_url    text NOT NULL,
    network         text NOT NULL DEFAULT 'solana:mainnet',
    amount_atomic   bigint NOT NULL DEFAULT 0,
    asset           text,
    tx_signature    text,
    response_data   jsonb,
    signal_data     jsonb,
    value_extracted jsonb,
    duration_ms     int,
    success         boolean NOT NULL,
    error_msg       text,
    pipeline        text
);

-- The autonomous log predates the value_extracted column the reconciliation
-- summary is written into (shared across run()-style pipelines; idempotent).
ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb;
