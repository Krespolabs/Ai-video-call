-- Sniper: per-strategy Telegram notification chat ID.
-- When set, buy/sell alerts fire to this chat instead of the global ops channel.
alter table agent_sniper_strategies
    add column if not exists telegram_chat_id text
        check (telegram_chat_id ~ '^-?[0-9]+$');
