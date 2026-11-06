-- Migration: Token Intel Pre-Snipe Gate — rugpull-risk verdicts per mint.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260627120000_token_intel_pre_snipe_gate.sql
-- Idempotent.
--
-- The autonomous x402 loop (self/023) pays /api/x402/token-intel ($0.01 USDC) for
-- the freshest pump.fun mints the sniper is about to consider and writes the
-- live due-diligence verdict here, one row per (mint, network). The verdict
-- carries a 0..100 rugpull sub-score (token-intel's risk.score — higher = riskier)
-- and a `rejected` boolean set when the risk level is high/critical.
--
-- Downstream consumer: workers/agent-sniper/oracle-gate.js reads this table on the
-- pre-snipe path (new_mint, first_claim, intel_confirmed, prelaunch-radar). A fresh
-- `rejected = true` row vetoes the snipe before any SOL is committed — the
-- "high-risk mints are auto-rejected" safety floor. The oracle feed can blend the
-- same sub-score into conviction. Fail-open by design: a missing/stale row never
-- blocks a snipe, so this layer can only ever make the sniper safer.

begin;

create table if not exists token_intel_risk (
    mint              text not null,
    network           text not null default 'mainnet' check (network in ('mainnet','devnet')),

    -- 0..100 rugpull sub-score (token-intel risk.score; higher = more risk).
    rugpull_score     int  not null default 0 check (rugpull_score between 0 and 100),
    risk_level        text not null default 'unknown'
                        check (risk_level in ('low','medium','high','critical','unknown')),
    -- true when level is high/critical → the sniper auto-rejects this mint.
    rejected          boolean not null default false,

    -- the token-intel market read behind the score (audit trail + feed blending).
    signal            text,                                  -- bullish|bearish|neutral
    confidence        numeric(4,3),                          -- 0..1
    symbol            text,
    price_usd         numeric(20,10),
    change_24h        numeric,
    market_cap_usd    numeric,
    liquidity_usd     numeric,
    volume_24h_usd    numeric,
    factors           jsonb not null default '[]'::jsonb,    -- [{label,status,detail}]

    -- provenance: the x402 settlement that produced this verdict.
    tx_signature      text,
    run_id            uuid,
    checked_at        timestamptz not null default now(),

    primary key (mint, network)
);

-- Pre-snipe lookup is by (mint, network); the gate also treats rows older than a
-- freshness window as absent, so index the recency too.
create index if not exists token_intel_risk_checked
    on token_intel_risk (network, checked_at desc);
create index if not exists token_intel_risk_rejected
    on token_intel_risk (network, rejected, checked_at desc) where rejected = true;

comment on table token_intel_risk is
    'Per-mint rugpull-risk verdicts from the x402 Token Intel Pre-Snipe Gate (self/023). '
    'Consumed by workers/agent-sniper/oracle-gate.js to auto-reject high-risk mints pre-snipe.';

commit;
