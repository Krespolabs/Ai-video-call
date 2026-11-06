-- Sniper strategy: Oracle conviction gate.
-- Adds min_oracle_score so a sniper strategy can require a minimum Oracle
-- conviction score before executing a buy. Applied to first_claim and
-- intel_confirmed triggers (where the coin already has some history);
-- new_mint snipes almost never have a score yet so the field is advisory.
alter table agent_sniper_strategies
    add column if not exists min_oracle_score smallint
        check (min_oracle_score >= 0 and min_oracle_score <= 100);
