-- Per-endpoint volume ledger for the x402 Volume Bootstrap Loop.
--
-- Populated by the "Volume Bootstrap Loop" autonomous x402 pipeline
-- (api/_lib/x402/autonomous-registry.js → volume-bootstrap-loop, implemented in
-- api/_lib/x402/pipelines/volume-bootstrap-loop.js). On each run the loop
-- round-robins through the catalog of paid, cheap self x402 endpoints, pays each
-- a real on-chain USDC payment, and upserts one row per endpoint here —
-- accumulating call / success / fail counts and total + last USDC spent.
--
-- Downstream consumer: the platform's growth + status surfaces read this table
-- for proof-of-volume (total settled calls and USDC volume per endpoint — the
-- metric agentic.market ranks facilitators on) and per-endpoint liveness
-- (last_success / last_called_at confirms each paid endpoint is live). It
-- complements x402_autonomous_log (per-call history) with a compact rolling
-- aggregate keyed on endpoint.
--
-- The pipeline also creates this lazily (ensureSchema), so this migration is
-- belt-and-suspenders for environments that run db:migrate.

create table if not exists x402_volume_metrics (
    endpoint_key        text primary key,
    service_name        text,
    endpoint_path       text,
    network             text not null default 'solana:mainnet',
    asset               text,
    call_count          bigint not null default 0,
    success_count       bigint not null default 0,
    fail_count          bigint not null default 0,
    total_spent_atomic  bigint not null default 0,
    last_amount_atomic  bigint not null default 0,
    last_success        boolean,
    last_status         integer,
    last_tx_signature   text,
    last_error          text,
    last_run_id         uuid,
    first_called_at     timestamptz default now(),
    last_called_at      timestamptz default now()
);

-- Status surfaces rank by most-recently swept endpoint.
create index if not exists x402_volume_metrics_last_called
    on x402_volume_metrics (last_called_at desc);
