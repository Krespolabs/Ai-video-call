-- Oracle agent watch: conviction-weighted position sizing.
--
-- When size_scaling is true, the agent loop scales each buy up to 1.5× the
-- configured per_trade_sol based on how far above the minimum threshold the
-- coin's conviction score lands. A coin at 100 gets 1.5× the base size; one
-- at the exact minimum gets 1.0×. The executor still applies its hard SOL cap.

begin;

alter table oracle_agent_watch
    add column if not exists size_scaling boolean not null default false;

comment on column oracle_agent_watch.size_scaling is
    'When true, scale position size by conviction: 1.0× at min_score, up to 1.5× at 100.';

commit;
