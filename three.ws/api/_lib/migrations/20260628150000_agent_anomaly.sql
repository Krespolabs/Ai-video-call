begin;

-- Behavioral anomaly timeline for custodial agent wallets — the audit + UI side
-- of the wallet's immune system (api/_lib/wallet-anomaly.js scores every outbound
-- action; this table records each scored decision so the owner can see WHY).
--
-- One row per scored outbound action (allow OR freeze). It is intentionally
-- separate from agent_custody_events (the money ledger): that table is the
-- accounting record, this one is the explainability + adjudication record. A row
-- links back to its custody event via custody_event_id when one exists.
--
-- Lifecycle:
--   status = 'allowed'   scored below threshold, action permitted
--   status = 'flagged'   scored at/above threshold → wallet auto-frozen, action held
--   status = 'approved'  owner confirmed "this was me" → unfrozen + baseline taught
--   status = 'denied'    owner confirmed bad → wallet stays frozen
create table if not exists agent_anomaly_events (
    id                bigserial    primary key,
    agent_id          uuid         not null,
    user_id           uuid,                                -- wallet owner
    network           text         not null default 'mainnet',
    category          text,                                -- trade | snipe | x402 | withdraw
    asset             text,
    usd               numeric,                             -- USD value of the scored action (null when unpriceable)
    destination       text,                                -- counterparty (base58) when present
    score             numeric      not null default 0,     -- 0..1 anomaly score
    decision          text         not null,               -- allow | freeze
    critical          boolean      not null default false, -- a catastrophic factor fired
    sensitivity       text,                                -- preset in force at decision time
    factors           jsonb        not null default '[]'::jsonb,  -- named contributing factors
    summary           text,                                -- one-line plain-language explanation
    status            text         not null default 'allowed',    -- allowed | flagged | approved | denied
    hour_utc          smallint,                            -- decision hour (for "teach the baseline")
    custody_event_id  bigint,                              -- the spend row this scored, if any
    adjudicated_by    uuid,
    adjudicated_at    timestamptz,
    swept             boolean      not null default false, -- owner used one-tap "sweep to safety"
    meta              jsonb        not null default '{}'::jsonb,
    created_at        timestamptz  not null default now()
);

-- Owner-facing timeline reads newest-first per agent.
create index if not exists agent_anomaly_events_agent_time
    on agent_anomaly_events (agent_id, id desc);

-- The hub badges/polls open flags (a freeze awaiting the owner's one-tap call).
create index if not exists agent_anomaly_events_open
    on agent_anomaly_events (agent_id, created_at desc)
    where status = 'flagged';

comment on table agent_anomaly_events is
    'Per-agent behavioral anomaly timeline for custodial wallets. One row per '
    'scored outbound action (allow/freeze) with named factors + plain-language '
    'summary. Owner-viewable via GET /api/agents/:id/solana/guard. Scoring lives '
    'in api/_lib/wallet-anomaly.js; config in agent_identities.meta.anomaly.';

commit;
