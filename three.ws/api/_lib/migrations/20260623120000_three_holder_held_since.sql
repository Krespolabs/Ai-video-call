-- Migration: track continuous $THREE holding duration per wallet.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260623120000_three_holder_held_since.sql
-- Idempotent + re-runnable.
--
-- The agent financial reputation score (api/_lib/trust/wallet-reputation.js) gains
-- a "$THREE conviction" pillar: holding the platform's only coin, and holding it
-- through time, is a costly on-chain commitment to three.ws. The holder snapshot
-- (three_holder_snapshot) already caches every $THREE holder's balance, refreshed
-- every few minutes by api/cron/three-holders-snapshot.js — so it is the cheapest
-- possible source for the score (one indexed lookup, no Helius walk).
--
-- This adds held_since: the moment a wallet's UNBROKEN hold began. It is set on
-- first insert and preserved on every refresh; a wallet that fully exits its
-- $THREE is hard-deleted by the snapshot, so re-entry honestly restarts the clock.
-- We never fabricate history: existing rows backfill to their last snapshot time.

alter table three_holder_snapshot
	add column if not exists held_since timestamptz;

update three_holder_snapshot
	set held_since = coalesce(held_since, updated_at, now())
	where held_since is null;
