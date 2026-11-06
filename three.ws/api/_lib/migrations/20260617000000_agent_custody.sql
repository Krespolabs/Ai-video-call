begin;

-- Custody audit trail + spend ledger for agent custodial wallets.
--
-- Agent Solana wallets are custodial: the platform holds the AES-GCM-encrypted
-- secret and signs server-side. This table is the single, owner-viewable record
-- of everything sensitive that happens to those funds:
--   - 'key_recover'  the encrypted secret was decrypted to sign (with a reason)
--   - 'withdraw'     the owner swept SOL/SPL out to an address
--   - 'spend'        an outbound payment from an automated path
--                    (category: 'trade' | 'snipe' | 'x402' | 'withdraw')
--   - 'limit_change' the owner edited the per-agent spend policy
--
-- It doubles as the spend ledger: the shared guardrail in
-- api/_lib/agent-trade-guards.js sums `usd` over the last 24h of 'spend' rows to
-- enforce the per-agent daily ceiling uniformly across every outbound path.
-- Spend limits themselves live in agent_identities.meta.spend_limits (jsonb) —
-- this table is the audit/accounting side, not the config side.
create table if not exists agent_custody_events (
    id               bigserial    primary key,
    agent_id         uuid         not null,
    user_id          uuid,                              -- actor / owner (null when system)
    event_type       text         not null,            -- key_recover | withdraw | spend | limit_change
    category         text,                              -- spend path: trade | snipe | x402 | withdraw
    network          text         not null default 'mainnet',
    asset            text,                              -- 'SOL' | mint base58 | 'USDC'
    amount_lamports  bigint,                            -- SOL amount (lamports)
    amount_raw       numeric,                           -- SPL token base units
    usd              numeric,                           -- normalized USD value (null when unpriceable)
    destination      text,                              -- withdraw recipient (base58)
    signature        text,                              -- on-chain tx signature
    reason           text,                              -- key_recover reason / freeform note
    status           text         not null default 'ok',  -- ok | pending | confirmed | failed
    idempotency_key  text,                              -- client-supplied; dedupes withdraw retries
    meta             jsonb        not null default '{}'::jsonb,
    created_at       timestamptz  not null default now(),
    updated_at       timestamptz  not null default now()
);

-- Idempotency: one row per (agent, idempotency_key). A withdraw retry with the
-- same key reuses the claimed row instead of broadcasting a second transaction.
create unique index if not exists agent_custody_events_idem
    on agent_custody_events (agent_id, idempotency_key)
    where idempotency_key is not null;

-- The owner-facing audit feed reads newest-first per agent.
create index if not exists agent_custody_events_agent_time
    on agent_custody_events (agent_id, created_at desc);

-- The daily-spend ceiling query sums recent 'spend' rows per agent+network.
create index if not exists agent_custody_events_spend
    on agent_custody_events (agent_id, network, created_at)
    where event_type = 'spend';

comment on table agent_custody_events is
    'Per-agent custody audit trail + spend ledger for custodial Solana wallets. '
    'Owner-viewable via GET /api/agents/:id/solana/custody. Spend rows back the '
    'daily ceiling enforced by api/_lib/agent-trade-guards.js across '
    'trade/snipe/x402/withdraw. Spend limits config lives in '
    'agent_identities.meta.spend_limits, not here.';

commit;
