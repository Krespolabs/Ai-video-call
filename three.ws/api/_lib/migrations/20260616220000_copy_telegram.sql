-- Copy subscriptions: per-subscription Telegram chat ID for intent notifications.
-- When set, the fanout cron sends a Telegram message each time a new pending
-- intent is generated for this subscription, letting the copier act immediately.
-- Idempotent.
alter table copy_subscriptions
    add column if not exists telegram_chat_id text
        check (telegram_chat_id ~ '^-?[0-9]+$');

comment on column copy_subscriptions.telegram_chat_id is
    'Optional Telegram chat ID (numeric string). When set, copier receives a
     message each time the fanout cron creates a pending copy intent for this
     subscription — buy alerts only (sell intents are informational, not urgent).';
