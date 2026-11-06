-- app_flags — generic runtime feature flags, flippable without a redeploy.
--
-- Each row is one named switch the platform reads at request/cron time. The
-- canonical use is gating headless seed crons (e.g. 'avaturn_seed') so an
-- operator can arm or disarm them instantly from the admin console instead of
-- editing a Vercel env var and waiting for a build. A missing row means "fall
-- back to the code default" (usually the matching env var), so adopting a flag
-- never changes behavior until someone actually sets it.
create table if not exists app_flags (
    key         text primary key,
    enabled     boolean not null default false,
    -- Optional structured payload for flags that carry more than on/off
    -- (cadence overrides, percentages, allowlists). Null for plain switches.
    value       jsonb,
    updated_by  uuid references users(id) on delete set null,
    updated_at  timestamptz not null default now()
);
