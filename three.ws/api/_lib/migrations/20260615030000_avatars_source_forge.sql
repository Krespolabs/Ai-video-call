-- Allow 'forge' as a valid source for AI-generated avatars seeded by the cron.
-- The previous constraint only covered user-uploaded sources; platform-seeded
-- content via forge-seed-cron uses source='forge' for clear provenance.

ALTER TABLE avatars
DROP CONSTRAINT avatars_source_check,
ADD CONSTRAINT avatars_source_check
    CHECK (source = ANY (ARRAY[
        'upload', 'avaturn', 'readyplayer', 'import',
        'direct-upload', 'reconstruct', 'studio', 'forge'
    ]));
