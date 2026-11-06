-- Sniper coin sentiment — per-coin live market read from the x402 Crypto Intel
-- feed, used as a snipe-threshold modifier.
--
-- Populated by the "Sniper Intel Enrichment" autonomous x402 loop entry
-- (api/_lib/x402/autonomous-registry.js → sniper-intel-enrich). On each run the
-- loop pays $0.01 USDC per call to /api/x402/crypto-intel for the coins the
-- sniper is actively watching (open positions + freshest high-conviction Oracle
-- candidates), maps the headline signal (bullish/bearish/neutral) + confidence
-- into a clamped score-point delta, and upserts one row per coin here. Crypto
-- Intel 503s (un-charged) for any ticker CoinGecko can't resolve, so a memecoin
-- with no real market never receives a wrong-coin signal — rows only ever carry
-- a signal a real market produced.
--
-- Downstream consumer: workers/agent-sniper/oracle-gate.js
-- (coinSentimentAdjustment) folds the fresh per-coin delta into the effective
-- min_oracle_score before the sniper commits SOL — bearish raises the bar,
-- bullish lowers it. Fail-open and clamped to ±10 points: a missing or stale row
-- never moves the bar, so this layer can only nudge a snipe, never dominate it.
--
-- The enrichment pipeline also creates this lazily (ensureSchema), so this
-- migration is belt-and-suspenders for environments that run db:migrate.

create table if not exists sniper_coin_sentiment (
    mint           text not null,
    network        text not null default 'mainnet' check (network in ('mainnet', 'devnet')),
    symbol         text,
    topic          text,
    signal         text,
    headline       text,
    rationale      text,
    confidence     numeric(5, 4),
    price_usd      numeric(20, 10),
    change_24h     numeric,
    sentiment_adj  smallint not null default 0,
    source         text not null default 'crypto-intel',
    tx_signature   text,
    run_id         uuid,
    checked_at     timestamptz not null default now(),
    primary key (mint, network)
);

-- The gate reads the freshest row per (mint, network); index the recency scan.
create index if not exists sniper_coin_sentiment_checked
    on sniper_coin_sentiment (network, checked_at desc);
