begin;

-- Oracle agent followers: lets any Telegram user subscribe to an agent's
-- conviction signals without arming their own agent. When an armed agent
-- executes (or simulates) a buy, all followers of that agent receive a
-- real-time Telegram alert with the coin, score, and deep link to Oracle.
create table if not exists oracle_followers (
    id              bigserial primary key,
    agent_id        uuid        not null,
    chat_id         text        not null,     -- Telegram chat ID (user or group)
    network         text        not null default 'mainnet',
    min_score       int         not null default 54,   -- only signal at this score+
    created_at      timestamptz not null default now(),
    unique (agent_id, chat_id, network)
);

create index if not exists oracle_followers_agent
    on oracle_followers (agent_id, network);

comment on table oracle_followers is
    'Telegram subscribers for Oracle agent conviction signals. '
    'Separate from oracle_agent_watch (that table is for the agent owner arming their own bot). '
    'Followers get a read-only feed of an armed agent''s buys — the Watch tier of social copy-trading.';

commit;
