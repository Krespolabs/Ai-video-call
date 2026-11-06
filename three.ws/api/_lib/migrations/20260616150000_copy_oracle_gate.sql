-- Copy trading: Oracle conviction gate.
-- Adds min_oracle_score to copy_subscriptions so copiers can require a
-- minimum conviction score before a copy intent is generated.
alter table copy_subscriptions
    add column if not exists min_oracle_score smallint
        check (min_oracle_score >= 0 and min_oracle_score <= 100);
