begin;

-- Money Pulse (prompts/agent-wallets/07) — indexes for the platform-wide public
-- activity feed (GET /api/pulse).
--
-- The global feed scans agent_custody_events and pump_agent_mints by
-- (network, created_at desc) across ALL agents — the existing indexes are
-- per-agent only, so without these the feed would seq-scan as the ledger grows.

-- Public-feed custody rows: tips received + outbound spends (trade/snipe/x402).
-- Withdraws are event_type='spend' too but category='withdraw'; they are filtered
-- out in the query (never public). The partial predicate keeps the index small.
create index if not exists agent_custody_events_pulse
    on agent_custody_events (network, created_at desc)
    where event_type in ('tip', 'spend');

-- Launch feed ordered newest-first per network.
create index if not exists pump_agent_mints_network_time
    on pump_agent_mints (network, created_at desc);

commit;
