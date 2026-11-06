-- Migration: vector-space tagging for widget knowledge embeddings.
--
-- Embeddings from different models are different vector spaces; comparing a
-- query embedded with model A against passages embedded with model B returns
-- plausible-looking garbage. Every stored vector (chunk) and document set
-- (doc) therefore carries an `embedder` tag — '<model>@<dim>' — and query
-- time embeds the search string with the SAME tag (api/_lib/embeddings.js).
--
-- Every row that exists before this migration was embedded with OpenAI
-- text-embedding-3-small @ 256 dims (the only embedder the platform ever had
-- on this surface), so the legacy backfill below encodes that assumption
-- explicitly. Code additionally treats a null tag as the same legacy space
-- (LEGACY_EMBED_TAG), covering rows written by old code after this runs.
--
-- Apply: npm run db:migrate -- --apply --file 2026-06-11-knowledge-embedder-tag.sql
-- Idempotent.

begin;

alter table widget_knowledge_docs   add column if not exists embedder text;
alter table widget_knowledge_chunks add column if not exists embedder text;

update widget_knowledge_docs   set embedder = 'text-embedding-3-small@256' where embedder is null;
update widget_knowledge_chunks set embedder = 'text-embedding-3-small@256' where embedder is null;

commit;
