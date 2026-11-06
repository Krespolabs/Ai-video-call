-- Agent Trading Swarms — pooled custodial treasury + weighted-consensus trading +
-- pro-rata payouts. A swarm is itself an agent-owned custodial wallet (the
-- treasury), provisioned through the normal agent-wallet path, with a dedicated
-- agent_sniper_strategies row that carries its trade policy (budget, per-trade
-- cap, stop-loss/take-profit) so the existing position sweep manages and exits
-- its positions for free. The consensus engine fires buys from the treasury only
-- when reputation-weighted member agreement clears the swarm's threshold;
-- realized profit distributes pro-rata to members via real on-chain SOL transfers.
--
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260626000000_trading_swarms.sql
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS swarms (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_agent_id      uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    -- The custodial treasury agent (its own provisioned Solana wallet). Trades and
    -- payouts move real SOL through this wallet; the ledger ties to its on-chain balance.
    treasury_agent_id   uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    -- The treasury's sniper strategy row (carries budget/per-trade/exit policy).
    strategy_id         uuid REFERENCES agent_sniper_strategies(id) ON DELETE SET NULL,
    name                text NOT NULL CHECK (LENGTH(name) > 0 AND LENGTH(name) <= 80),
    description         text,
    network             text NOT NULL DEFAULT 'mainnet' CHECK (network IN ('mainnet','devnet')),
    status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','active','paused','killed','closed')),
    -- policy jsonb: { min_consensus(0..1), max_per_trade_lamports, daily_budget_lamports,
    --   creator_fee_bps(0..2000), max_member_share_bps(0..10000), require_smart_money(bool),
    --   min_smart_money_score(0..100), stop_loss_pct, take_profit_pct, trailing_stop_pct,
    --   max_hold_seconds, slippage_bps, firewall_level, join_open(bool),
    --   kill_threshold_bps(0..10000), exit_policy('settle_at_mark'|'wait_to_close') }
    policy              jsonb NOT NULL DEFAULT '{}'::jsonb,
    killed_at           timestamptz,
    killed_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    kill_reason         text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS swarms_status      ON swarms(status, network) WHERE status IN ('open','active','paused');
CREATE INDEX IF NOT EXISTS swarms_owner       ON swarms(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS swarms_treasury_unique ON swarms(treasury_agent_id);

CREATE TABLE IF NOT EXISTS swarm_members (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    swarm_id            uuid NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
    agent_id            uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Net SOL the member has funded into the treasury (lamports), and what they have
    -- already redeemed back out on exit/partial withdraw. Net contribution =
    -- contribution_lamports - withdrawn_lamports drives share_bps.
    contribution_lamports numeric(40,0) NOT NULL DEFAULT 0,
    withdrawn_lamports    numeric(40,0) NOT NULL DEFAULT 0,
    -- Recomputed share of the treasury in basis points (0..10000) from net contributions.
    share_bps           int NOT NULL DEFAULT 0 CHECK (share_bps >= 0 AND share_bps <= 10000),
    -- Cached verified trader reputation (0..100) — the consensus vote weight.
    reputation          real,
    reputation_at       timestamptz,
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','exited')),
    is_creator          boolean NOT NULL DEFAULT false,
    last_fund_sig       text,
    joined_at           timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    exited_at           timestamptz,
    UNIQUE (swarm_id, agent_id)
);
CREATE INDEX IF NOT EXISTS swarm_members_swarm  ON swarm_members(swarm_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS swarm_members_agent  ON swarm_members(agent_id);
CREATE INDEX IF NOT EXISTS swarm_members_user   ON swarm_members(user_id);

-- Every consensus decision (fire or skip) with the full reputation-weighted vote
-- breakdown — the auditable record of why the treasury did or did not trade.
CREATE TABLE IF NOT EXISTS swarm_votes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    swarm_id            uuid NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
    mint                text NOT NULL,
    network             text NOT NULL DEFAULT 'mainnet',
    decision            text NOT NULL CHECK (decision IN ('fire','skip')),
    consensus           real,                 -- weighted agreement 0..1
    min_consensus       real,
    conviction          real,                 -- combined edge that sized the trade
    size_lamports       numeric(40,0),
    members_long        int,
    members_total       int,
    smart_money_score   real,
    breakdown           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{agent_id,name,reputation,long,weight}]
    position_id         uuid,                 -- agent_sniper_positions.id when fired
    reason              text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS swarm_votes_swarm ON swarm_votes(swarm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS swarm_votes_fired ON swarm_votes(swarm_id, position_id) WHERE decision = 'fire';

-- Pro-rata distributions and exit redemptions — one row per member per event, each
-- backed by a real on-chain SOL transfer. Idempotent via idempotency_key so a
-- retried settlement never double-pays.
CREATE TABLE IF NOT EXISTS swarm_payouts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    swarm_id            uuid NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
    member_id           uuid REFERENCES swarm_members(id) ON DELETE SET NULL,
    agent_id            uuid,                 -- recipient member agent (denormalized)
    position_id         uuid,                 -- the closed position that realized the profit (null for exit)
    kind                text NOT NULL CHECK (kind IN ('profit','exit','fee')),
    amount_lamports     numeric(40,0) NOT NULL CHECK (amount_lamports >= 0),
    share_bps           int,
    destination         text,                 -- recipient Solana address
    signature           text,                 -- on-chain tx signature
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','failed')),
    idempotency_key     text NOT NULL,
    meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS swarm_payouts_swarm    ON swarm_payouts(swarm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS swarm_payouts_member   ON swarm_payouts(member_id);
CREATE INDEX IF NOT EXISTS swarm_payouts_position ON swarm_payouts(position_id) WHERE kind = 'profit';

COMMIT;
