-- agent_memory_pins — records every IPFS CID an agent has pinned via
-- POST /api/agents/:id/memory/pin, so the read proxy
-- (GET /api/agents/:id/memory/:cid) can verify the requested CID actually
-- belongs to that agent instead of acting as a generic authenticated IPFS
-- fetch proxy for any CID.
create table if not exists agent_memory_pins (
    agent_id    uuid not null references agent_identities(id) on delete cascade,
    cid         text not null,
    filename    text not null,
    bytes       integer not null default 0,
    created_at  timestamptz not null default now(),
    primary key (agent_id, cid)
);

create index if not exists agent_memory_pins_agent
    on agent_memory_pins(agent_id, created_at desc);
