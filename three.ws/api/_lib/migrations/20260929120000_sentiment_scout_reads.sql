-- 20260929120000_sentiment_scout_reads.sql
--
-- The Sentiment Scout (api/_lib/sentiment-scout.js, GET /api/pump/sentiment-scout)
-- ranks pump.fun launches by sourced momentum and hands back every claim with
-- its receipt: the source link, the time the fact was true, and the on-chain
-- facts a social claim was checked against. Until now nothing it said was kept,
-- so two questions had no answer:
--
--   1. "Had the Scout flagged this coin before the agent bought it?" A trade
--      receipt (api/_lib/trade-receipt.js) can only show that if the first
--      sighting, with the evidence as it stood then, was recorded.
--   2. "Is the Scout any good?" Its calls can only be graded against the Coin
--      Intelligence Engine's outcome labels (pump_coin_outcomes) if the calls
--      were kept.
--
-- One row per coin. The first_* columns are written once, on the first board
-- appearance, and never change: they are what receipts and the track record
-- read. The last_* / evidence columns follow the latest read.
--
-- Also: agent_sniper_strategies.llm_scout_context, a per-strategy opt-in that
-- hands the Scout's read to that strategy's LLM judge. Off by default, so every
-- running LLM experiment keeps asking exactly the question it was asking.
--
-- Additive and idempotent, safe to re-run.

create table if not exists sentiment_scout_reads (
    mint              text not null,
    network           text not null default 'mainnet' check (network in ('mainnet', 'devnet')),
    symbol            text,
    first_scouted_at  timestamptz not null default now(),
    first_score       smallint not null check (first_score between 0 and 100),
    first_evidence    jsonb not null default '[]'::jsonb,
    first_caution     text,
    last_scouted_at   timestamptz not null default now(),
    last_score        smallint not null check (last_score between 0 and 100),
    peak_score        smallint not null check (peak_score between 0 and 100),
    evidence          jsonb not null default '[]'::jsonb,
    caution           text,
    x_summary         jsonb,
    posts             jsonb,
    primary key (mint, network)
);

create index if not exists sentiment_scout_reads_first_idx
    on sentiment_scout_reads (network, first_scouted_at desc);

comment on table sentiment_scout_reads is
    'Every coin the Sentiment Scout put on its board: the first sighting (score, evidence, caution; immutable) and the latest read. Read by trade receipts and the Scout track record.';
comment on column sentiment_scout_reads.first_evidence is
    'Evidence lines as they stood at the first sighting: [{type, detail, source, at, checked_against?}]. Never updated.';
comment on column sentiment_scout_reads.posts is
    'Up to three X posts quoting the exact contract address, as receipts: [{url, author, followers, verified, at, text, likes, reposts}].';

alter table agent_sniper_strategies
    add column if not exists llm_scout_context boolean not null default false;

comment on column agent_sniper_strategies.llm_scout_context is
    'When true, this LLM-judged strategy''s judge is also shown the Sentiment Scout''s sourced read of the coin (evidence lines, momentum score, caution). Off by default so existing experiments are unchanged.';
