begin;

-- Wallet Intents — the programmable, conversational money layer.
--
-- An intent is an owner-owned policy that makes an agent's custodial wallet
-- *react* to real events: "tip back anyone who tips me more than 0.1 SOL, half
-- of what they sent", "when my balance is under 0.05 SOL, freeze spending and DM
-- me", "every Friday, withdraw profit above 2 SOL to my main wallet", "split 10%
-- of everything I earn to my other agent". The owner writes the rule in plain
-- language; an LLM compiles it into a STRICT structured intent; the cron engine
-- (api/_lib/wallet-intents.js) evaluates enabled intents on their trigger and
-- executes through the SAME owner-authorized, spend-policy-gated, audited signing
-- paths every other outbound action uses. An intent can never exceed the agent's
-- spend policy (api/_lib/agent-trade-guards.js enforceSpendLimit) and every
-- execution writes an agent_custody_events row with meta.intent_id.
--
-- One agent = one owner (agent_identities.user_id, immutable). Intents are
-- owner-only: only the owner may create, arm, edit, pause, or delete one, and the
-- executor re-checks ownership against agent_identities at fire time. user_id is
-- the owner at creation; the executor always trusts the live agent_identities row.
--
-- Triggers (trigger_type): on_tip_received, on_income, on_balance_below,
--   on_schedule, on_launch_matching, on_stream_started.
-- Actions  (action_type): tip, transfer, buy, snipe, withdraw, split_income,
--   freeze, notify.
-- The only coin the platform promotes is $THREE; a mint named for a buy/snipe is
-- the owner's own runtime input, never hardcoded here.

create table if not exists agent_wallet_intents (
    id              uuid        primary key default gen_random_uuid(),
    agent_id        uuid        not null,
    user_id         uuid        not null,                       -- owner at creation (executor trusts live agent_identities.user_id)
    title           text        not null default '',            -- short owner-facing label
    trigger_type    text        not null,                       -- on_tip_received | on_income | on_balance_below | on_schedule | on_launch_matching | on_stream_started
    trigger_config  jsonb       not null default '{}'::jsonb,   -- e.g. { min_sol, threshold_sol, weekday, hour, creator, max_mcap_usd }
    action_type     text        not null,                       -- tip | transfer | buy | snipe | withdraw | split_income | freeze | notify
    action_config   jsonb       not null default '{}'::jsonb,   -- e.g. { pct, amount_sol, destination, destination_label, mint, slippage_pct, message }
    limits          jsonb       not null default '{}'::jsonb,   -- { per_action_usd, daily_usd, total_usd } — clamped under the agent spend policy
    network         text        not null default 'mainnet',     -- mainnet | devnet
    enabled         boolean     not null default true,          -- armed?
    public_trait    boolean     not null default false,         -- owner opt-in: advertise the BEHAVIOR (never the rule/caps) on the public persona
    source_text     text,                                       -- the plain-language instruction the owner described
    readback        text,                                       -- one-sentence confirmable summary
    fire_count      integer     not null default 0,             -- lifetime real executions
    spent_usd       numeric     not null default 0,             -- lifetime USD moved by this intent (real, from custody rows)
    last_fired_at   timestamptz,
    last_status     text,                                       -- ok | skipped | paused | error | notified
    last_note       text,
    last_signature  text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- Owner-facing list (newest first) for one agent.
create index if not exists agent_wallet_intents_agent
    on agent_wallet_intents (agent_id, created_at desc);

-- Cron scans: "every enabled intent of this trigger kind" (schedule/balance/launch
-- sweeps) and the tip/income/stream hot path ("enabled intents for THIS agent of
-- this trigger kind"). Partial on enabled keeps the working set small.
create index if not exists agent_wallet_intents_trigger
    on agent_wallet_intents (trigger_type, enabled)
    where enabled = true;

create index if not exists agent_wallet_intents_agent_trigger
    on agent_wallet_intents (agent_id, trigger_type, enabled)
    where enabled = true;

-- Public persona traits the owner opted to advertise (read-only behavior badges).
create index if not exists agent_wallet_intents_public
    on agent_wallet_intents (agent_id)
    where public_trait = true;

commit;
