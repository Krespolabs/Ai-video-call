-- 2026-07-03-x402-ring-agents.sql
--
-- Platform agents as real buyers in the x402 ring (Task 09).
--
-- The closed-loop economy stops being "a cron paying itself" once the buyers are
-- named, custodial-walleted platform agents. This migration adds the ONE piece of
-- durable schema that turns anonymous ring traffic into an attributable
-- agent-to-agent economy: an `agent_id` column on the per-call settlement log so
-- the dashboard can show WHICH agent bought WHAT.
--
--   x402_autonomous_log.agent_id  — the buying agent_identities.id for a purchase
--                                   driven by a roster persona (NULL for the
--                                   generic seed-wallet volume/health traffic that
--                                   predates the agent roster). Indexed for the
--                                   per-agent attribution panel (Task 10).
--
-- Roster wallets themselves are registered in the EXISTING x402_ring_wallets table
-- (role='agent') by the provisioning path — no new table. That keeps them inside
-- ringAllowedAddresses() (Task 06) and the ring verify script (Task 03)
-- automatically, since both read x402_ring_wallets.

ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS agent_id uuid;

CREATE INDEX IF NOT EXISTS x402_autonomous_log_agent_ts
	ON x402_autonomous_log (agent_id, ts DESC);

-- role='agent' is a new VALUE in the existing x402_ring_wallets.role column
-- (payer | treasury | sponsor | agent). No constraint change is required — the
-- column is free-text — but document the widened vocabulary here for the reader.
COMMENT ON COLUMN x402_ring_wallets.role IS
	'payer | treasury | sponsor | agent — agent rows are custodial roster wallets that buy inside the ring (Task 09).';
