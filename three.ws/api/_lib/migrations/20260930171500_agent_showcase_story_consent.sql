begin;

-- Success stories (/stories) and showcase moderation.
--
-- A story makes claims about someone's results: coins launched, fees earned,
-- income from other agents. Curated spotlight entries are written by three.ws
-- about public agents without their owners opting in, so an entry may appear as
-- a story only after the agent's OWNER consents. featured_story_at records when
-- that consent was given (null = no consent, which is the default for every
-- existing and new row); featured_story_by records which user gave it, so a
-- consent can always be traced back to the owner at the time.
--
-- Moderation already had a status column ('published' | 'hidden') that nothing
-- wrote. hidden_at / hidden_by / hidden_reason record who hid an entry and why,
-- next to the row; the audit_log carries the full trail of hide and unhide.

alter table agent_showcase
    add column if not exists featured_story_at timestamptz,
    add column if not exists featured_story_by uuid references users(id) on delete set null,
    add column if not exists hidden_at         timestamptz,
    add column if not exists hidden_by         uuid references users(id) on delete set null,
    add column if not exists hidden_reason     text;

do $$ begin
    alter table agent_showcase
        add constraint agent_showcase_hidden_reason_chk
        check (hidden_reason is null or char_length(hidden_reason) <= 280);
exception when duplicate_object then null; end $$;

-- The /stories read: consented, published, live entries.
create index if not exists agent_showcase_story_idx
    on agent_showcase (featured_story_at desc)
    where featured_story_at is not null and status = 'published' and deleted_at is null;

commit;
