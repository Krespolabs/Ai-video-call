-- Roll-forward: add the UNIQUE (agent_id, network) constraint to
-- agent_launcher_configs that 20260626200000_agent_capabilities.sql was edited
-- to declare *after* it had already been applied. Because that constraint lives
-- inside a CREATE TABLE IF NOT EXISTS, databases that ran the original file never
-- received it — leaving the capabilities upsert's ON CONFLICT (agent_id, network)
-- with no matching unique index. This migration reconciles existing databases.
-- Idempotent. Safe on fresh installs (the constraint may already exist there).

CREATE UNIQUE INDEX IF NOT EXISTS agent_launcher_configs_agent_network_uniq
    ON agent_launcher_configs (agent_id, network);
