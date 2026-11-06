-- 1. Add alpha_hunt as a valid trigger in agent_sniper_strategies.
--    The trigger column is text (no enum constraint), so we just document the new value.
--    Add alpha-hunt-specific gate columns:
ALTER TABLE agent_sniper_strategies
    ADD COLUMN IF NOT EXISTS alpha_min_smart_money     INTEGER   DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS alpha_min_organic_score   NUMERIC   DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS alpha_max_mcap_usd        NUMERIC   DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS alpha_narrative_keywords  TEXT[]    DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS alpha_min_quality_score   INTEGER   DEFAULT NULL;

-- 2. Launcher configs — one row per agent launch program
CREATE TABLE IF NOT EXISTS agent_launcher_configs (
    id                       BIGSERIAL PRIMARY KEY,
    agent_id                 UUID      NOT NULL,
    user_id                  UUID      NOT NULL,
    enabled                  BOOLEAN   NOT NULL DEFAULT false,
    network                  TEXT      NOT NULL DEFAULT 'mainnet',
    -- Schedule
    interval_hours           NUMERIC   DEFAULT NULL,       -- null = manual only
    max_launches             INTEGER   DEFAULT NULL,       -- null = unlimited
    -- Token metadata template
    name_template            TEXT      NOT NULL DEFAULT 'Agent Coin',
    symbol                   TEXT      NOT NULL DEFAULT 'AGENT',
    description              TEXT      DEFAULT NULL,
    image_url                TEXT      DEFAULT NULL,
    twitter                  TEXT      DEFAULT NULL,
    telegram                 TEXT      DEFAULT NULL,
    website                  TEXT      DEFAULT NULL,
    -- Initial dev buy
    initial_buy_sol          NUMERIC   NOT NULL DEFAULT 0,
    initial_buy_slippage_bps INTEGER   NOT NULL DEFAULT 500,
    -- Auto-claim from launches
    auto_claim_enabled        BOOLEAN  NOT NULL DEFAULT false,
    auto_claim_threshold_sol  NUMERIC  NOT NULL DEFAULT 0.5,
    auto_claim_reinvest_pct   INTEGER  NOT NULL DEFAULT 0 CHECK (auto_claim_reinvest_pct BETWEEN 0 AND 100),
    -- State
    launches_count           INTEGER   NOT NULL DEFAULT 0,
    last_launched_at         TIMESTAMPTZ DEFAULT NULL,
    next_launch_at           TIMESTAMPTZ DEFAULT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, network)
);
CREATE INDEX IF NOT EXISTS idx_agent_launcher_agent ON agent_launcher_configs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_launcher_next ON agent_launcher_configs(next_launch_at) WHERE enabled = true;

-- 3. Track each coin an agent has launched
CREATE TABLE IF NOT EXISTS agent_launched_coins (
    id                       BIGSERIAL PRIMARY KEY,
    launcher_id              BIGINT    REFERENCES agent_launcher_configs(id) ON DELETE SET NULL,
    agent_id                 UUID      NOT NULL,
    user_id                  UUID      NOT NULL,
    network                  TEXT      NOT NULL,
    mint                     TEXT      NOT NULL,
    symbol                   TEXT      NOT NULL,
    name                     TEXT      NOT NULL,
    launch_sig               TEXT      DEFAULT NULL,
    -- Performance tracking
    peak_mcap_usd            NUMERIC   DEFAULT NULL,
    is_graduated             BOOLEAN   NOT NULL DEFAULT false,
    graduated_at             TIMESTAMPTZ DEFAULT NULL,
    -- Creator fee state
    claimable_lamports       BIGINT    NOT NULL DEFAULT 0,
    total_claimed_lamports   BIGINT    NOT NULL DEFAULT 0,
    last_claim_sig           TEXT      DEFAULT NULL,
    last_claim_at            TIMESTAMPTZ DEFAULT NULL,
    last_fee_check_at        TIMESTAMPTZ DEFAULT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (mint, network)
);
CREATE INDEX IF NOT EXISTS idx_launched_coins_agent ON agent_launched_coins(agent_id);
-- auto_claim_enabled column convenience (on the launcher drives per-coin default,
-- but allow per-coin override in agent_launched_coins):
ALTER TABLE agent_launched_coins
    ADD COLUMN IF NOT EXISTS auto_claim_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_launched_coins_claim ON agent_launched_coins(agent_id, network) WHERE auto_claim_enabled OR launcher_id IS NOT NULL;

-- 4. Market maker configs — one per agent per coin
CREATE TABLE IF NOT EXISTS agent_market_maker_configs (
    id                       BIGSERIAL PRIMARY KEY,
    agent_id                 UUID      NOT NULL,
    user_id                  UUID      NOT NULL,
    enabled                  BOOLEAN   NOT NULL DEFAULT false,
    network                  TEXT      NOT NULL DEFAULT 'mainnet',
    mint                     TEXT      NOT NULL,
    symbol                   TEXT      DEFAULT NULL,
    -- Strategy parameters
    spread_bps               INTEGER   NOT NULL DEFAULT 200 CHECK (spread_bps >= 10),
    order_size_sol           NUMERIC   NOT NULL DEFAULT 0.05,
    max_inventory_sol        NUMERIC   NOT NULL DEFAULT 1.0,
    min_profit_bps           INTEGER   NOT NULL DEFAULT 50,
    rebalance_interval_ms    INTEGER   NOT NULL DEFAULT 10000,
    -- Execution
    mev_tip_mode             TEXT      NOT NULL DEFAULT 'economy' CHECK (mev_tip_mode IN ('off','economy','turbo')),
    -- Running totals
    total_buys               INTEGER   NOT NULL DEFAULT 0,
    total_sells              INTEGER   NOT NULL DEFAULT 0,
    total_volume_sol         NUMERIC   NOT NULL DEFAULT 0,
    total_pnl_sol            NUMERIC   NOT NULL DEFAULT 0,
    current_inventory_sol    NUMERIC   NOT NULL DEFAULT 0,
    last_tick_at             TIMESTAMPTZ DEFAULT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, mint, network)
);
CREATE INDEX IF NOT EXISTS idx_mm_agent ON agent_market_maker_configs(agent_id);
CREATE INDEX IF NOT EXISTS idx_mm_enabled ON agent_market_maker_configs(network) WHERE enabled = true;

-- 5. Market maker trade ledger
CREATE TABLE IF NOT EXISTS agent_market_maker_trades (
    id                       BIGSERIAL PRIMARY KEY,
    config_id                BIGINT    NOT NULL REFERENCES agent_market_maker_configs(id) ON DELETE CASCADE,
    agent_id                 UUID      NOT NULL,
    network                  TEXT      NOT NULL,
    side                     TEXT      NOT NULL CHECK (side IN ('buy','sell')),
    base_amount              BIGINT    NOT NULL,
    quote_lamports           BIGINT    NOT NULL,
    sig                      TEXT      DEFAULT NULL,
    price_lamports_per_token NUMERIC   DEFAULT NULL,
    realized_pnl_lamports    BIGINT    DEFAULT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mm_trades_config ON agent_market_maker_trades(config_id, created_at DESC);
