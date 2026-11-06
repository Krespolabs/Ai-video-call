-- Emotion & Embodiment — persistent agent mood (Living Agents · Task 07).
--
-- An agent carries a real emotional state derived from its mind and the user's
-- world: a point in the valence × arousal circumplex that moves only on real
-- signals (chat sentiment, memory, dreams, actions, market/alert events) and
-- decays toward a baseline. The *live snapshot* lives on agent_identities.meta
-- (meta.mood) so it restores instantly with the agent record; this table is the
-- append-only HISTORY that powers the "mood over time" sparkline and the
-- inspector's "what real signal moved it" feed.
--
-- Every row cites the signal that produced it — no mood change without a real
-- triggering signal is the product invariant, and the source column enforces it
-- as a data invariant too.

create table if not exists agent_mood_history (
    id          uuid primary key default gen_random_uuid(),
    agent_id    uuid not null references agent_identities(id) on delete cascade,
    -- The mood point AFTER this signal was applied + decayed.
    valence     real not null check (valence >= -1.0 and valence <= 1.0),
    arousal     real not null check (arousal >= 0.0 and arousal <= 1.0),
    -- Projected discrete mood (calm | alert | elated | content | agitated | subdued).
    label       text not null,
    -- The real signal that moved the mood here (e.g. 'chat:positive',
    -- 'action:failure', 'dream:insight'). Mandatory — provenance, not decoration.
    source      text not null,
    -- Human-readable summary of the signal for the inspector feed.
    source_label text,
    -- Optional provenance link to the memory that triggered this, when relevant.
    source_memory_id uuid references agent_memories(id) on delete set null,
    metadata    jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now()
);

create index if not exists agent_mood_history_agent_time
    on agent_mood_history(agent_id, created_at desc);

-- Live snapshot contract (written to agent_identities.meta.mood by the mood API):
--   meta.mood = {
--     valence:     number  (-1..1),
--     arousal:     number  (0..1),
--     label:       string,
--     sensitivity: number  (0..1)  -- the owner's "emotional sensitivity" setting
--     updated_at:  ISO8601 string
--   }
