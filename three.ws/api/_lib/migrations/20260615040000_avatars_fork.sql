-- GitHub-style avatar forks.
--
-- When one user "saves" another user's avatar it becomes a NEW avatar in the
-- saver's namespace (new owner_id, copied GLB), linked back to the original via
-- parent_avatar_id with full attribution in source_meta.forked_from. Neither
-- user can mutate or delete the other's row — they are independent objects.
--
-- 1. 'fork' joins the allowed source set so forked avatars carry clear provenance.
-- 2. fork_count caches how many times an avatar has been forked (for the
--    "Forked NN times" badge), maintained by api/avatars/fork.js.
-- 3. An index on parent_avatar_id makes "list forks of X" / fork-count backfill
--    cheap.

ALTER TABLE avatars
DROP CONSTRAINT avatars_source_check,
ADD CONSTRAINT avatars_source_check
    CHECK (source = ANY (ARRAY[
        'upload', 'avaturn', 'readyplayer', 'import',
        'direct-upload', 'reconstruct', 'studio', 'forge', 'fork'
    ]));

ALTER TABLE avatars
    ADD COLUMN IF NOT EXISTS fork_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_avatars_parent ON avatars (parent_avatar_id)
    WHERE parent_avatar_id IS NOT NULL;
