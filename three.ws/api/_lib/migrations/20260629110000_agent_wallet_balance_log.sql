-- Time-series log for the Agent Wallet Balance Monitor autonomous pipeline
-- (api/_lib/x402/wallet-balance-monitor.js). Every 10 minutes the autonomous
-- loop reads the seed/agent wallet's live USDC + SOL balance via the free
-- GET /api/x402-pay?balance=1, records one sample here, derives the burn rate
-- vs the previous sample, and flags low_balance when USDC drops below threshold.
-- The pipeline also creates this table lazily; this migration is belt-and-suspenders.
-- Consumer: api/ops/health.js folds a low/unconfigured wallet into the health verdict.

create table if not exists agent_wallet_balance_log (
    id                 bigserial primary key,
    ts                 timestamptz not null default now(),
    run_id             uuid,
    address            text,
    configured         boolean not null default true,
    usdc               numeric(20,6),
    sol                numeric(20,9),
    low_balance        boolean not null default false,
    threshold_usdc     numeric(20,6),
    usdc_delta         numeric(20,6),
    spend_rate_usdc_hr numeric(20,6),
    source             text
);

create index if not exists agent_wallet_balance_log_ts on agent_wallet_balance_log (ts desc);
