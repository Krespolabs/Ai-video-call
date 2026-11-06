-- Explicit per-strategy funding consent for the sniper auto-funder.
--
-- Before this, merely having an enabled mainnet strategy row made the agent's
-- wallet eligible for auto top-ups from the launcher master (workers/agent-sniper/
-- auto-funder.js). That is an implicit fund-moving trigger: arming a strategy
-- silently authorized real SOL to leave a master wallet on the next 5-minute
-- tick. This column makes that consent explicit and OFF by default — arming a
-- strategy no longer moves any money; the operator must opt each strategy in.
--
-- Fail-safe: the worker treats a missing/false value as "do not fund", so until
-- a strategy is explicitly opted in, the auto-funder leaves it alone.

ALTER TABLE agent_sniper_strategies
  ADD COLUMN IF NOT EXISTS auto_fund_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN agent_sniper_strategies.auto_fund_enabled IS
  'Explicit consent: when true, the sniper auto-funder may top this agent''s wallet up from the launcher master (bounded by SNIPER_AUTO_FUND_* caps). Default false — arming a strategy never moves money on its own.';
