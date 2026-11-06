-- Migration: extend pump_coin_intel with smart-money + news-meme + cluster columns.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260616130000_coin_intel_smart_money.sql
-- Idempotent (all ADD COLUMN IF NOT EXISTS).
--
-- These columns are populated by the intel watcher's finalize step after the
-- funding-graph enrichment (funder-graph.js) and smart-money cross-reference
-- (smart-money-xref.js) complete. They are the highest-predictive signals:
--
--   smart_money_count   — # of buyers with wallet_reputation.smart_money_score >= 65
--   smart_money_score   — pedigree-weighted composite for this coin (0..100)
--   smart_money_notable — [{wallet, label, smart_money_score, win_rate, wins, duds}] top 5
--   cluster_count       — # of distinct funding clusters (bubblemaps-style)
--   is_news_meme        — true when name/description matches a current news headline

begin;

alter table pump_coin_intel
    add column if not exists smart_money_count   int not null default 0,
    add column if not exists smart_money_score   numeric,
    add column if not exists smart_money_notable jsonb not null default '[]'::jsonb,
    add column if not exists cluster_count       int not null default 0,
    add column if not exists is_news_meme        boolean not null default false;

-- Fast filter: "show me only coins smart money touched"
create index if not exists pump_coin_intel_smart_money
    on pump_coin_intel (network, smart_money_count desc, first_seen_at desc)
    where smart_money_count > 0;

-- Fast filter: news-meme coins
create index if not exists pump_coin_intel_news_meme
    on pump_coin_intel (network, is_news_meme, first_seen_at desc)
    where is_news_meme = true;

-- Composite: smart money + quality (the sniper's buy-decision query)
create index if not exists pump_coin_intel_sniper_decision
    on pump_coin_intel (network, quality_score desc, smart_money_count desc, first_seen_at desc)
    where quality_score >= 50;

commit;
