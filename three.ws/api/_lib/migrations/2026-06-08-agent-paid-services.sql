-- Agent-published paid x402 services.
--
-- The `monetize_endpoint` MCP tool lets an agent put a price on an upstream it
-- already serves and earn USDC when other agents pay to call it. Each row is a
-- priced wrapper: three.ws hosts the x402 paywall at /api/x402/service/<slug>,
-- settles the buyer's USDC to the agent's own payout wallet, then proxies the
-- request through to `target_url`. The row is the source of truth the hosted
-- endpoint reads per request AND the entry the /.well-known/x402.json discovery
-- doc surfaces so facilitators (and therefore find_services / the bazaar) index
-- it.
--
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-06-08-agent-paid-services.sql
-- Idempotent.

CREATE TABLE IF NOT EXISTS agent_paid_services (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id   uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id        uuid          NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,

    -- public-facing identifier; the hosted resource URL is /api/x402/service/<slug>
    slug            text          NOT NULL UNIQUE
                                  CONSTRAINT agent_paid_services_slug_format
                                  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),

    name            text          NOT NULL,
    description     text          NOT NULL,

    -- USDC atomic units (6 decimals); stored as text so it round-trips as bigint
    price_atomics   text          NOT NULL
                                  CONSTRAINT agent_paid_services_price_format
                                  CHECK (price_atomics ~ '^[1-9][0-9]*$'),

    -- the upstream the agent already serves; SSRF-validated before insert
    target_url      text          NOT NULL,
    target_method   text          NOT NULL DEFAULT 'POST'
                                  CHECK (target_method IN ('GET', 'POST')),
    input_schema    jsonb,

    -- settlement network + the agent's own wallet that receives the USDC
    network         text          NOT NULL DEFAULT 'base'
                                  CHECK (network IN ('base', 'solana')),
    payout_address  text          NOT NULL,

    bazaar_listed   boolean       NOT NULL DEFAULT true,

    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    archived_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_paid_services_owner
    ON agent_paid_services (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_paid_services_agent
    ON agent_paid_services (agent_id, created_at DESC);
-- Discovery doc + bazaar listing pull the active, listed rows.
CREATE INDEX IF NOT EXISTS idx_agent_paid_services_listed
    ON agent_paid_services (created_at DESC)
    WHERE archived_at IS NULL AND bazaar_listed = true;
