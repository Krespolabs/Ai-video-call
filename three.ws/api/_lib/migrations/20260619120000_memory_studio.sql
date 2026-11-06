-- Memory Studio (P2) — tiered memory + semantic search + temporal entity graph.
--
-- Adds the proven tiered model (Letta/MemGPT: working / recall / archival) and
-- mem0-style add()/search() ergonomics to agent_memories, plus a Zep/Graphiti-
-- style temporal knowledge graph of the entities (mints, tickers, wallets,
-- people, strategies) the agent's memories mention.
--
-- Vectors are stored as JSONB float arrays tagged with the embedder that
-- produced them (model id + dim), mirroring widget_knowledge_chunks. Different
-- embedders are different vector spaces; query-time code embeds with the SAME
-- tag and never compares across tags (api/_lib/embeddings.js scoreRowsBySpace).

-- ── tiered memory + recall bookkeeping on agent_memories ──────────────────────
alter table agent_memories add column if not exists tier text not null default 'recall'
    check (tier in ('working', 'recall', 'archival'));
alter table agent_memories add column if not exists embedding jsonb;
alter table agent_memories add column if not exists embedder text;       -- vector-space tag
alter table agent_memories add column if not exists pinned boolean not null default false;
alter table agent_memories add column if not exists last_accessed_at timestamptz;
alter table agent_memories add column if not exists access_count integer not null default 0;
-- Lazy-processing flag: set true once entities have been extracted + linked for
-- this row. The search/graph read paths process any row still false, so every
-- write path (api/agent-memory.js POST and /api/agents/:id/memories POST) is
-- covered uniformly without coupling the writers to the extractor.
alter table agent_memories add column if not exists entities_extracted boolean not null default false;

-- Working set: pinned + high-salience rows the agent always carries in context.
create index if not exists agent_memories_working
    on agent_memories(agent_id, salience desc)
    where tier = 'working' and expires_at is null;
-- Rows still needing a vector (lazy embed cursor).
create index if not exists agent_memories_needs_embed
    on agent_memories(agent_id, created_at desc)
    where embedding is null and expires_at is null;
-- Rows still needing entity extraction (lazy graph cursor).
create index if not exists agent_memories_needs_entities
    on agent_memories(agent_id, created_at desc)
    where entities_extracted = false and expires_at is null;

-- ── agent_memory_entities — the nodes of the temporal knowledge graph ─────────
-- One row per distinct (agent, normalized entity). `kind` buckets the entity:
--   mint     — a Solana token mint address (runtime data only; $THREE is the
--              only coin the platform promotes — see CLAUDE.md)
--   ticker   — a $SYMBOL cashtag
--   wallet   — a base58 wallet / account address
--   person   — an @handle
--   strategy — a rule/strategy tag the agent follows
--   topic    — a free tag
create table if not exists agent_memory_entities (
    id            uuid primary key default gen_random_uuid(),
    agent_id      uuid not null references agent_identities(id) on delete cascade,
    kind          text not null,
    label         text not null,                          -- display form
    normalized    text not null,                          -- dedupe key (lowercased / canonical)
    salience      real not null default 0.5,
    mention_count integer not null default 0,
    first_seen_at timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    meta          jsonb not null default '{}'::jsonb,
    unique (agent_id, kind, normalized)
);
create index if not exists agent_memory_entities_agent
    on agent_memory_entities(agent_id, last_seen_at desc);
create index if not exists agent_memory_entities_kind
    on agent_memory_entities(agent_id, kind, mention_count desc);

-- ── agent_memory_entity_links — which memory mentions which entity ────────────
-- Edges between entities are derived at read time from co-occurrence within the
-- same memory (two entities linked here to the same memory_id share an edge).
create table if not exists agent_memory_entity_links (
    entity_id   uuid not null references agent_memory_entities(id) on delete cascade,
    memory_id   uuid not null references agent_memories(id) on delete cascade,
    created_at  timestamptz not null default now(),
    primary key (entity_id, memory_id)
);
create index if not exists agent_memory_entity_links_memory
    on agent_memory_entity_links(memory_id);
