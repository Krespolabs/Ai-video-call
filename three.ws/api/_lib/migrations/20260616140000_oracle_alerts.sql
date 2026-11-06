-- Oracle conviction alerts — add alerted_at column so we never fire twice
-- for the same coin even across serverless cold-starts.

alter table oracle_conviction
    add column if not exists alerted_at timestamptz;

create index if not exists oracle_conviction_alerted
    on oracle_conviction (network, alerted_at)
    where alerted_at is not null;
