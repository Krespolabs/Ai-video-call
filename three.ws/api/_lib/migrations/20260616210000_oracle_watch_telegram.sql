begin;

alter table oracle_agent_watch
    add column if not exists telegram_chat_id text;

comment on column oracle_agent_watch.telegram_chat_id is
    'Optional personal Telegram chat ID. When set, the owner receives a direct message whenever a coin clears their min_score threshold and whenever their agent takes an action.';

commit;
