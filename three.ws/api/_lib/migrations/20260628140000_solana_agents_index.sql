-- solana_agents_index — crawled directory of every on-chain Solana agent that
-- lives OUTSIDE three.ws's own agent_identities table. Two upstream registries
-- are folded into one table via the `source` column:
--
--   'metaplex' → Metaplex Agent Registry (program 1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p).
--                Each AgentIdentity account points at a Metaplex Core `asset`;
--                name/image/uri are enriched from that asset's DAS record.
--   'agenc'    → AgenC coordination protocol (Tetsuo Corp). Each agentRegistration
--                account carries authority, capabilities, endpoint and metadataUri;
--                name/image/description are enriched from metadataUri JSON.
--
-- Populated by api/cron/[name].js → handleSolanaAgentsCrawl (cron name
-- `solana-agents-crawl`). The /agents directory (via /api/explore?source=agents)
-- reads this alongside erc8004_agents_index (EVM) and agent_identities (ours) so
-- the index shows the whole ecosystem, not just three.ws-launched agents.
create table if not exists solana_agents_index (
    source           text        not null,             -- 'metaplex' | 'agenc'
    ref              text        not null,              -- on-chain account pubkey (PDA), base58 — unique within source
    network          text        not null default 'mainnet',
    owner            text,                              -- authority / asset owner, base58
    asset            text,                              -- Metaplex Core asset pubkey (metaplex source)
    agent_id         text,                              -- AgenC 32-byte agent id, base58 (agenc source)
    name             text,
    description      text,
    image            text,                              -- 2D thumbnail URL
    glb_url          text,                              -- 3D model endpoint when the agent advertises one
    metadata_uri     text,                              -- off-chain metadata pointer (asset json_uri / agenc metadataUri)
    endpoint         text,                              -- AgenC service endpoint (URL or DID)
    capabilities     text,                              -- AgenC capability bitmask, decimal string
    reputation       integer,                           -- AgenC on-chain reputation score
    status           text,                              -- registry-specific status label (e.g. 'active', 'suspended')
    has_3d           boolean     not null default false,
    x402_support     boolean     not null default false,
    active           boolean     not null default true, -- false once de-registered / suspended on-chain
    registered_at    timestamptz,
    last_metadata_at timestamptz,
    metadata_error   text,
    last_seen_at     timestamptz not null default now(),
    primary key (source, ref)
);

create index if not exists solana_agents_active_time
    on solana_agents_index(registered_at desc) where active;
create index if not exists solana_agents_source_time
    on solana_agents_index(source, registered_at desc) where active;
create index if not exists solana_agents_owner
    on solana_agents_index(owner) where active;
create index if not exists solana_agents_asset
    on solana_agents_index(asset) where asset is not null;
create index if not exists solana_agents_metadata_stale
    on solana_agents_index(last_metadata_at nulls first);
