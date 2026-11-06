-- Migration: arm the Memetic Launcher by default + add a standing dev buy.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260629120000_launcher_live_default.sql
--        (or `npm run db:migrate`). Idempotent.
--
-- The launcher previously shipped inert (global row enabled=false, dry_run=true)
-- and made no initial buy. This flips the platform default to LIVE: the global
-- launcher mints real pump.fun coins on a cadence, and every launch now includes
-- a small dev buy on its own curve so the launching agent holds a position if the
-- coin takes off. Hard caps (per-launch SOL, daily SOL, hourly count, cadence)
-- and the auto-tripping circuit breaker still bound the blast radius unchanged.
--
-- Economics: per_launch_sol covers the ~0.022 SOL deploy cost + the dev buy +
-- priority-fee headroom. With dev_buy_sol = 0.01 we budget 0.04 SOL per launch,
-- preserving the original ~0.008 SOL margin on top of deploy cost.

begin;

-- New installs (table created by this migration run) inherit the live defaults.
alter table launcher_config alter column enabled     set default true;
alter table launcher_config alter column dry_run      set default false;
alter table launcher_config alter column per_launch_sol set default 0.04;
alter table launcher_config alter column dev_buy_sol  set default 0.01;

-- Existing deployments: arm the seeded global row and give it the dev buy. Scope
-- to 'global' so any per-user launcher policy keeps its own switches. Leave
-- `paused` untouched — that's the circuit breaker, not the master switch.
update launcher_config
   set enabled        = true,
       dry_run        = false,
       dev_buy_sol    = greatest(dev_buy_sol, 0.01),
       per_launch_sol = greatest(per_launch_sol, 0.04),
       updated_at     = now()
 where scope = 'global';

-- Fresh DBs with no global row yet: seed it live.
insert into launcher_config (scope, enabled, dry_run, mode, per_launch_sol, dev_buy_sol)
values ('global', true, false, 'hybrid', 0.04, 0.01)
on conflict do nothing;

commit;
