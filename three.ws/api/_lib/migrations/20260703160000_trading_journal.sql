-- Trade journal — the "learn what works" surface for the trading experiment.
--
-- Every entry and every exit leg is recorded WITH its reasoning: why a mint was
-- bought (trigger, mcap, score) and why/how much was sold (take-initials /
-- trailing / stop / timeout, the fraction, the leg PnL). PnL alone teaches
-- nothing; the decision log with the *why* is what you learn from. Written by
-- workers/agent-sniper/journal.js (which also creates it lazily), read via
-- /api/sniper/journal.

CREATE TABLE IF NOT EXISTS trading_journal (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts               timestamptz NOT NULL DEFAULT now(),
    agent_id         text,
    position_id      bigint,
    network          text,
    mint             text,
    symbol           text,
    event            text NOT NULL,        -- entry | take_initials | exit
    reason           text,                 -- entry trigger, or exit reason
    mode             text,                 -- live | simulate
    venue            text,
    sold_fraction    numeric,
    leg_pnl_lamports numeric,
    market_cap_usd   numeric,
    score            numeric,
    rationale        text,                 -- human-readable "why"
    sig              text
);

CREATE INDEX IF NOT EXISTS trading_journal_agent_ts_idx ON trading_journal (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS trading_journal_position_idx ON trading_journal (position_id);
