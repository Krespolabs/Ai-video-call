-- Laddered partial-exit support for the sniper (the "take initials, hold a moon
-- bag" rule). Opt-in: a strategy with a NULL initials_out_multiple keeps the
-- classic single-shot full-exit behavior, so existing strategies are unchanged.
--
--   initials_out_multiple  when the position first reaches this × entry (e.g.
--                          2.0), sell exactly enough to return the initial cost
--                          basis and keep the rest as a moon bag. NULL = ladder
--                          off (classic behavior).
--   moonbag_min_pct        the minimum % of the position that must ALWAYS remain
--                          on the take-initials event — a full exit on the way up
--                          is impossible. Default 15.
--
-- Position state:
--   initials_recovered     set true once the take-initials sell has executed, so
--                          the ladder fires exactly once and the remainder then
--                          rides on the trailing stop.

ALTER TABLE agent_sniper_strategies
  ADD COLUMN IF NOT EXISTS initials_out_multiple numeric,
  ADD COLUMN IF NOT EXISTS moonbag_min_pct       numeric NOT NULL DEFAULT 15;

ALTER TABLE agent_sniper_positions
  ADD COLUMN IF NOT EXISTS initials_recovered boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN agent_sniper_strategies.initials_out_multiple IS
  'Take-initials ladder: at this × entry, sell enough to recover the cost basis and hold a moon bag. NULL = ladder off (classic full-exit).';
COMMENT ON COLUMN agent_sniper_strategies.moonbag_min_pct IS
  'Minimum % of the position always kept on the take-initials event (a full exit on the way up is impossible). Default 15.';
COMMENT ON COLUMN agent_sniper_positions.initials_recovered IS
  'True once the take-initials partial sell executed; the remaining moon bag then rides on the trailing stop.';
