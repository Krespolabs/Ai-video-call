-- Periodic portfolio-value snapshots for agent custodial wallets.
--
-- Powers the wallet identity layer's micro P&L sparkline + 24h change. Every
-- time the batch balance endpoint (POST /api/agents/balances) values a wallet it
-- records a real, on-chain-derived total USD value here (deduped to at most one
-- row per wallet per ~5 min). The 24h change and sparkline are then derived from
-- the real series — never a synthesized curve. A wallet with fewer than two
-- snapshots renders the empty sparkline state, by design.
--
-- This is option (2) from the wallet-identity P&L spec: persist periodic balance
-- snapshots server-side and derive change from them. No external price-history
-- API required; the series densifies organically from real browsing traffic and
-- can be backfilled by a cron later without schema changes.

create table if not exists wallet_value_snapshots (
	id           bigserial primary key,
	agent_id     uuid not null references agent_identities(id) on delete cascade,
	address      text not null,
	usd_value    numeric(20, 6) not null,
	sol_amount   numeric(20, 9),
	captured_at  timestamptz not null default now()
);

-- The hot query is "latest N snapshots for this agent within the last ~26h",
-- ordered by time. A composite (agent_id, captured_at desc) index serves both the
-- sparkline read and the dedup "is the most recent row older than 5 min?" check.
create index if not exists wallet_value_snapshots_agent_time_idx
	on wallet_value_snapshots (agent_id, captured_at desc);

-- Snapshots are ephemeral telemetry, not a ledger: keep the table small by
-- letting a retention sweep delete anything older than the sparkline window.
-- Indexing captured_at alone makes that bulk delete cheap.
create index if not exists wallet_value_snapshots_captured_idx
	on wallet_value_snapshots (captured_at);
