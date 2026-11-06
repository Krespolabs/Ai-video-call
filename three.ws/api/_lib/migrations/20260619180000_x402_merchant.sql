-- x402 Merchant Console — the "Stripe of x402" account settings.
--
-- One row per merchant (user). Captures everything a merchant configures to run
-- a paid x402 business on three.ws: payout/agent wallets (where settled USDC
-- arrives), default settlement network, branding, CORS/domain allow-list,
-- security limits (spend caps, SIWX, network allow-list), an API key for the
-- key-bypass lane, a webhook URL for settlement events, and a drag-and-drop
-- storefront layout published at /store/<handle>.
--
-- The API key is stored hashed (sha256, hex). We keep only a short display
-- prefix so the dashboard can show `x402_live_ab12…` without holding the secret.

CREATE TABLE IF NOT EXISTS x402_merchant_settings (
    owner_user_id      uuid          PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

    -- Branding shown across hosted checkout + storefront
    business_name      text,
    support_email      text,
    logo_url           text,
    accent_color       text          DEFAULT '#0a84ff'
                                     CHECK (accent_color IS NULL OR accent_color ~* '^#[0-9a-f]{6}$'),

    -- Payout / agent wallets — where settled funds land. The most important
    -- config: a misconfigured payout sends real money to the wrong place.
    payout_evm         text          CHECK (payout_evm IS NULL OR payout_evm ~* '^0x[0-9a-f]{40}$'),
    payout_solana      text          CHECK (payout_solana IS NULL OR char_length(payout_solana) BETWEEN 32 AND 44),
    default_network    text          NOT NULL DEFAULT 'base'
                                     CHECK (default_network IN ('base', 'solana')),

    -- Agent wallets — the named on-chain identities a merchant authorizes to
    -- AUTO-PAY (role=payer) or RECEIVE (role=payout) on its behalf, each scoped
    -- by its own per-call / daily USDC cap. This is the heart of the console: a
    -- merchant runs a fleet of agents that transact x402 with no human in the
    -- loop, and this is where they bound what each one may move.
    --   [{ id, label, address, chain, role, enabled,
    --      per_call_cap_atomics, daily_cap_atomics }]
    agent_wallets      jsonb         NOT NULL DEFAULT '[]'::jsonb,

    -- Settlement facilitator override. NULL/'' → platform default facilitator.
    facilitator        text,

    -- CORS / domain allow-list for the merchant's own embeds (jsonb array of origins)
    cors_origins       jsonb         NOT NULL DEFAULT '[]'::jsonb,

    -- Security
    spend_cap_per_call_atomics  text,                       -- null = no cap
    spend_cap_daily_atomics     text,                       -- null = no cap
    require_siwx       boolean       NOT NULL DEFAULT false, -- re-entry must sign in
    allowed_networks   jsonb         NOT NULL DEFAULT '["base","solana"]'::jsonb,

    -- Giving — optional charity split (basis points of every settled payment)
    -- routed to a cause wallet, plus buyer round-up (round the total up to the
    -- nearest unit and donate the difference). The cause address is validated
    -- against charity_chain in the API.
    charity_enabled    boolean       NOT NULL DEFAULT false,
    charity_name       text,
    charity_chain      text          CHECK (charity_chain IS NULL OR charity_chain IN ('base', 'solana')),
    charity_address    text,
    charity_bps        int           NOT NULL DEFAULT 0
                                     CHECK (charity_bps BETWEEN 0 AND 10000),
    roundup_enabled    boolean       NOT NULL DEFAULT false,
    roundup_to_atomics text,

    -- Developer: API key (hashed) + settlement webhook
    api_key_hash       text,
    api_key_prefix     text,
    api_key_created_at timestamptz,
    webhook_url        text,

    -- Storefront (drag-and-drop builder)
    store_handle       text          UNIQUE
                                     CHECK (store_handle IS NULL OR store_handle ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
    store_published    boolean       NOT NULL DEFAULT false,
    store_layout       jsonb         NOT NULL DEFAULT '[]'::jsonb,  -- ordered array of blocks
    store_theme        jsonb         NOT NULL DEFAULT '{}'::jsonb,  -- { mode, bg, accent }

    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_x402_merchant_store
    ON x402_merchant_settings (store_handle) WHERE store_published = true;

-- Idempotent column adds (guard for environments where an earlier cut of this
-- table already exists without the agent-wallet / facilitator config).
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS agent_wallets jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS facilitator   text;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS charity_enabled    boolean NOT NULL DEFAULT false;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS charity_name       text;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS charity_chain      text;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS charity_address    text;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS charity_bps        int NOT NULL DEFAULT 0;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS roundup_enabled    boolean NOT NULL DEFAULT false;
ALTER TABLE x402_merchant_settings ADD COLUMN IF NOT EXISTS roundup_to_atomics text;

-- Products = SKUs. Add commerce/display columns so storefront cards can render
-- a price + image without a live 402 probe, and so products can be ordered and
-- toggled active without archiving. All optional → backward compatible.
ALTER TABLE x402_skus ADD COLUMN IF NOT EXISTS image_url       text;
ALTER TABLE x402_skus ADD COLUMN IF NOT EXISTS price_atomics   text;   -- display price (raw token units)
ALTER TABLE x402_skus ADD COLUMN IF NOT EXISTS price_network   text;   -- 'base' | 'solana' the price is quoted in
ALTER TABLE x402_skus ADD COLUMN IF NOT EXISTS position        int     NOT NULL DEFAULT 0;
ALTER TABLE x402_skus ADD COLUMN IF NOT EXISTS active          boolean NOT NULL DEFAULT true;
