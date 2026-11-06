-- pumpfun_signals: allow multiple signal kinds per transaction + add a crawl cursor.
--
-- 1) The original schema declared `tx_signature text unique`, which makes it
--    impossible to store more than ONE signal kind per pump.fun transaction —
--    e.g. a single first-time creator-fee claim that is ALSO `influencer` tier
--    AND from a `new_account` should produce three rows, but the second/third
--    inserts collide on the bare tx_signature unique. The correct dedup key is
--    (tx_signature, kind): exactly one row per (transaction, signal kind).
--    Drop the single-column unique and replace it with the composite.
--
-- 2) The pumpfun-signals cron previously re-scanned the full recent-events
--    window every run (relying on ON CONFLICT DO NOTHING to no-op the dups).
--    pumpfun_signals_cursor lets the cron persist the newest event timestamp it
--    has processed per source so each run only evaluates genuinely new events.
--    The cursor lives in Postgres (NOT Redis) to keep Upstash write volume flat
--    — see tasks/redis-burn-rate-reduction.md.

begin;

-- 0) A signal can be agent-attributed without a specific actor wallet — e.g. the
--    self-sourced graduation signal pump-agent-stats emits keys off the token
--    mint (agent_asset) and has no claimer wallet. The original `wallet not null`
--    made that insert fail silently, so relax it.
alter table pumpfun_signals alter column wallet drop not null;

-- 1) Replace the bare tx_signature unique with a composite (tx_signature, kind).
--    Drop the auto-named constraint/index from the inline `unique` declaration.
alter table pumpfun_signals drop constraint if exists pumpfun_signals_tx_signature_key;
drop index if exists pumpfun_signals_tx_signature_key;

do $$
begin
	if not exists (
		select 1 from pg_constraint where conname = 'pumpfun_signals_tx_kind_key'
	) then
		alter table pumpfun_signals
			add constraint pumpfun_signals_tx_kind_key unique (tx_signature, kind);
	end if;
end $$;

-- Channel-feed reads recent signals newest-first across all kinds.
create index if not exists pumpfun_signals_seen_at on pumpfun_signals(seen_at desc);

-- 2) Per-source crawl cursor. `last_seen_ms` is the epoch-millisecond timestamp
--    of the newest event the cron has evaluated for that source; the next run
--    skips anything strictly older. `last_signature` is kept for observability.
create table if not exists pumpfun_signals_cursor (
	source         text        primary key,   -- 'claims' | 'whales' | 'mints' | 'graduations'
	last_seen_ms   bigint      not null default 0,
	last_signature text,
	updated_at     timestamptz not null default now()
);

commit;
