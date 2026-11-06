-- Migration: mark revenue that settled straight into the agent's own wallet.
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260930141000_agent_revenue_events_settled_to_wallet.sql
-- Idempotent.
--
-- agent_revenue_events doubles as the withdrawable-balance ledger: withdrawals
-- pay an owner out of the platform treasury up to sum(net_amount). A sale of an
-- agent as a paid x402 API (POST /api/x402/agents/:id) settles the buyer's USDC
-- on chain directly to the agent's payout wallet, so the owner already holds
-- that money. Counting it as withdrawable would let the treasury pay it a
-- second time. The row is still real income (the Earn tab, the economy summary
-- and every earnings view read it), so it is kept and flagged instead:
-- settled_to_wallet = true means "already in the owner's wallet, never a
-- treasury liability". Every existing row keeps the old meaning (false).

alter table agent_revenue_events
	add column if not exists settled_to_wallet boolean not null default false;

create index if not exists agent_revenue_events_agent_skill_created
	on agent_revenue_events (agent_id, skill, created_at desc);
