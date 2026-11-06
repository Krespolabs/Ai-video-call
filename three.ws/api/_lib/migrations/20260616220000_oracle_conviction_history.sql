begin;

create table if not exists oracle_conviction_history (
    id          bigserial primary key,
    mint        text        not null,
    network     text        not null default 'mainnet',
    score       int         not null,
    tier        text        not null,
    pedigree    int,
    structure   int,
    narrative   int,
    momentum    int,
    scored_at   timestamptz not null default now()
);

create index if not exists oracle_conviction_history_lookup
    on oracle_conviction_history (mint, network, scored_at desc);

comment on table oracle_conviction_history is
    'Append-only record of oracle conviction scores over time. Written whenever a coin''s score changes by ≥3 points or it is scored for the first time. Keeps 72 hours of history — older rows are purged by the score cron.';

commit;
