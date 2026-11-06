-- Forge quality tiers + generation path — record how each mesh was generated.
--
-- /forge gained two new request axes (see api/_lib/forge-tiers.js):
--
--   path  — "image"    (image-intermediate: text→image→mesh, the fast default)
--           "geometry" (geometry-first: native text→mesh / image→mesh with no
--                       synthesized intermediate view)
--   tier  — "draft" | "standard" | "high" — the target polygon budget + texture
--           richness. The high tier produces a visibly denser mesh.
--
-- The `backend` column already exists (added by the multiview migration); these
-- two columns complete the provenance so every job result can report
-- tier + backend + path, and the data flywheel can segment training pairs by
-- generation route and quality.

alter table forge_creations add column if not exists tier text;
alter table forge_creations add column if not exists path text;
