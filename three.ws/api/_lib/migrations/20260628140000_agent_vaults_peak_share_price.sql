begin;

-- Ensure agent_vaults tracks peak SHARE PRICE (NAV per share, scaled 1e6) rather
-- than raw NAV for the drawdown circuit breaker — so deposits/redemptions, which
-- move NAV but not share price, can never falsely trip it.
--
-- Idempotent + order-independent: the base migration (20260628130000) defines the
-- column as `peak_share_price_e6` directly, so on a fresh apply this is a no-op.
-- On any database that materialized the earlier `peak_nav_atomics` name, this
-- renames it in place. Guarded so it never errors in either state.
do $$
begin
	if exists (
		select 1 from information_schema.columns
		where table_name = 'agent_vaults' and column_name = 'peak_nav_atomics'
	) and not exists (
		select 1 from information_schema.columns
		where table_name = 'agent_vaults' and column_name = 'peak_share_price_e6'
	) then
		alter table agent_vaults rename column peak_nav_atomics to peak_share_price_e6;
	end if;
end $$;

commit;
