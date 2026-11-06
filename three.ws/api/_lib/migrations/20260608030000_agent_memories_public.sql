-- Opt-in public memories for user profiles.
-- Memories are owner-only by default (api/agent-memory.js and the
-- /api/agents/:id/memories handler only ever return rows to the owner).
-- `is_public` lets an owner deliberately surface a memory on their public
-- profile at /u/<username>. Default false so nothing leaks without an
-- explicit toggle.

alter table agent_memories add column if not exists is_public boolean not null default false;

-- Read path for the public profile: public, non-expired memories for an agent,
-- newest first.
create index if not exists agent_memories_public
    on agent_memories(agent_id, created_at desc)
    where is_public = true and expires_at is null;
