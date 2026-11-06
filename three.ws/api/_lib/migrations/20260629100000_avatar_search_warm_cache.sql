-- Warm-cache for the public avatar gallery search pipeline.
--
-- Populated by the "Avatar Search Index Warmup" autonomous x402 loop entry
-- (api/_lib/x402/autonomous-registry.js → avatar-search-warmup). On each run the
-- loop pays per call to /api/mcp (search_public_avatars) for ~20 common queries,
-- then upserts the ranked, thumbnail-resolved results here.
--
-- Downstream consumer: GET /api/avatars/popular-searches reads this table to
-- serve "popular search" suggestion chips (with sample thumbnails) on the public
-- gallery, and the cached payload lets the gallery paint instant results for a
-- common query before the live DB round-trip returns.
--
-- The warmup helper also creates this lazily (ensureWarmCacheSchema), so this
-- migration is belt-and-suspenders for environments that run db:migrate.

create table if not exists avatar_search_warm_cache (
    query          text primary key,
    result_count   integer not null default 0,
    top_results    jsonb not null default '[]'::jsonb,
    thumbnails     text[] not null default '{}',
    has_thumbnails boolean not null default false,
    warmed_at      timestamptz not null default now(),
    run_id         uuid
);

-- "Popular searches" ranks by how much public inventory a query surfaces, then
-- by recency of the warm pass.
create index if not exists avatar_search_warm_cache_rank
    on avatar_search_warm_cache (result_count desc, warmed_at desc);
