-- usage_events — LLM cost accounting columns.
--
-- usage_events already logs that an LLM call happened (kind='llm') but not which
-- provider/model served it, how many tokens it burned, or what it cost. Without
-- that, platform LLM spend (e.g. the Anthropic credit balance) is invisible.
--
-- This migration is purely additive and idempotent — safe to run repeatedly and
-- against a DB that already has the columns. Cost is stored in micro-USD
-- (1 cost_micro_usd = $0.000001) as a bigint so spend sums never drift on floats.

alter table usage_events add column if not exists provider       text;
alter table usage_events add column if not exists model          text;
alter table usage_events add column if not exists input_tokens   int;
alter table usage_events add column if not exists output_tokens  int;
alter table usage_events add column if not exists cost_micro_usd bigint;

-- Spend reads scan llm events over a time window and group by provider/model.
create index if not exists usage_events_llm_time
    on usage_events(created_at desc)
    where kind = 'llm';

create index if not exists usage_events_llm_provider_time
    on usage_events(provider, created_at desc)
    where kind = 'llm' and provider is not null;
