-- Programmable Orders Engine (trading-frontier/02).
--
-- A real, set-and-forget order layer for agent-wallet pump.fun trading: limit,
-- stop, trailing stop, DCA, TWAP, and validated conditional triggers. A worker
-- (workers/agent-orders) sweeps active orders, re-quotes each mint off live
-- on-chain state, evaluates the trigger/schedule, and on fire executes through
-- the SAME firewall + spend-guard + custody pipeline as every other agent trade
-- (api/agents/agent-trade.js executeAgentTrade). `orders` is the rule; the
-- `order_fills` rows are the per-execution audit trail (each linked to its
-- agent_custody_events row, the canonical spend ledger).

-- ── orders ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id              UUID NOT NULL,
    user_id               UUID NOT NULL,
    network               TEXT NOT NULL DEFAULT 'mainnet',
    mint                  TEXT NOT NULL,
    symbol                TEXT,
    type                  TEXT NOT NULL,          -- limit|stop|trailing|dca|twap|conditional
    side                  TEXT NOT NULL,          -- buy|sell

    -- sizing: buys spend SOL (size_sol); sells dispose tokens (size_tokens raw
    -- base units) OR a fraction of the live holding (sell_pct, 0–100).
    size_sol              NUMERIC,
    size_tokens           NUMERIC,
    sell_pct              NUMERIC,

    -- price triggers. The metric these values are expressed in is `trigger_metric`
    -- (see CHECK). limit_price/stop_price are the target in that metric; trail_pct
    -- is the drawdown/run-up percent for a trailing stop and peak_price its tracked
    -- high/low-water mark (also in trigger_metric units).
    trigger_metric        TEXT NOT NULL DEFAULT 'mcap_usd',  -- price_sol|mcap_sol|mcap_usd
    limit_price           NUMERIC,
    stop_price            NUMERIC,
    trail_pct             NUMERIC,
    peak_price            NUMERIC,
    reference_price       NUMERIC,                -- metric value at creation (display + change conditions)

    -- DCA / TWAP schedule. { interval_seconds, slices, filled_slices }
    schedule              JSONB,
    next_fire_at          TIMESTAMPTZ,

    -- conditional trigger: a validated, code-free condition spec
    -- { all|any: [ { signal, op, value } ] }
    condition             JSONB,

    -- execution params
    slippage_bps          INTEGER NOT NULL DEFAULT 500,
    max_price_impact_pct  NUMERIC,
    expires_at            TIMESTAMPTZ,

    -- lifecycle state
    status                TEXT NOT NULL DEFAULT 'active',  -- active|partial|firing|paused|filled|cancelled|expired|error
    filled_sol            NUMERIC NOT NULL DEFAULT 0,
    filled_tokens         NUMERIC NOT NULL DEFAULT 0,
    fill_count            INTEGER NOT NULL DEFAULT 0,
    last_eval_at          TIMESTAMPTZ,
    last_price            NUMERIC,                -- last observed metric value
    last_error            TEXT,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at          TIMESTAMPTZ,

    CONSTRAINT orders_type_check    CHECK (type IN ('limit','stop','trailing','dca','twap','conditional')),
    CONSTRAINT orders_side_check    CHECK (side IN ('buy','sell')),
    CONSTRAINT orders_status_check  CHECK (status IN ('active','partial','firing','paused','filled','cancelled','expired','error')),
    CONSTRAINT orders_network_check CHECK (network IN ('mainnet','devnet')),
    CONSTRAINT orders_metric_check  CHECK (trigger_metric IN ('price_sol','mcap_sol','mcap_usd')),
    CONSTRAINT orders_slippage_check CHECK (slippage_bps BETWEEN 1 AND 5000)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'orders' AND indexname = 'idx_orders_agent') THEN
        CREATE INDEX idx_orders_agent ON orders(agent_id, network, created_at DESC);
    END IF;
END $$;

-- The worker's hot work-set: orders still in play, ordered for scheduling.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'orders' AND indexname = 'idx_orders_active') THEN
        CREATE INDEX idx_orders_active ON orders(network, next_fire_at)
            WHERE status IN ('active','partial','firing');
    END IF;
END $$;

-- ── order_fills ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_fills (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    agent_id            UUID NOT NULL,
    network             TEXT NOT NULL,
    slice_index         INTEGER,                  -- DCA/TWAP slice number (0-based)
    side                TEXT NOT NULL,
    trigger_reason      TEXT,                     -- 'limit', 'trailing_stop', 'condition', 'dca_slice', …
    trigger_price       NUMERIC,                  -- metric value that fired the order
    sol_amount          NUMERIC,                  -- SOL spent (buy) / SOL received (sell)
    token_amount        NUMERIC,                  -- base units bought/sold
    price_impact_pct    NUMERIC,
    venue               TEXT,                     -- bonding_curve|amm
    signature           TEXT,
    custody_event_id    BIGINT,                   -- FK-ish into agent_custody_events.id
    status              TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|failed|simulated|unconfirmed
    detail              TEXT,
    meta                JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT order_fills_status_check CHECK (status IN ('pending','confirmed','failed','simulated','unconfirmed'))
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'order_fills' AND indexname = 'idx_order_fills_order') THEN
        CREATE INDEX idx_order_fills_order ON order_fills(order_id, created_at DESC);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'order_fills' AND indexname = 'idx_order_fills_agent') THEN
        CREATE INDEX idx_order_fills_agent ON order_fills(agent_id, created_at DESC);
    END IF;
END $$;
