-- Avatar gallery alt text (T4.1, Consumer 3 of the shared vision helper).
--
-- Accessibility is not optional (CLAUDE.md): every gallery image needs a
-- meaningful alt attribute, not just the avatar's name. This column stores a
-- vision-generated description of the avatar's thumbnail, written on thumbnail
-- upload and backfilled for existing rows by scripts/backfill-avatar-alt-text.mjs.
--
-- Nullable + additive: a null means "not generated yet"; the gallery falls back
-- to the avatar name, so this never breaks rendering before the backfill runs.

alter table avatars add column if not exists alt_text text;
