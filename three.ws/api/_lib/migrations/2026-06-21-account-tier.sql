-- Migration: add users.account_tier — the granted account "mode" shown on a
-- member's card (api/_lib/account-tier.js). NULL = the default 'user' tier.
-- 'holder' is derived live from on-chain $THREE and is never stored here, so it
-- is intentionally absent from the CHECK list. Idempotent.
begin;

alter table users
    add column if not exists account_tier text;

-- Constrain to the admin-grantable modes. Added separately (not inline) so the
-- constraint lands on deployments where the column already exists from a prior
-- partial run. NOT VALID keeps the lock light; existing NULLs already satisfy it.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'users_account_tier_check'
    ) then
        alter table users
            add constraint users_account_tier_check
            check (account_tier is null or account_tier in ('beta', 'pro', 'three-dimensional'))
            not valid;
    end if;
end $$;

commit;
