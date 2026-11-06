-- Forge multi-view reconstruction — record how a generation was conditioned.
--
-- /forge previously fed a single reference image (or one synthesized from a
-- prompt) into the reconstruction model. Multi-view conditioning (2–4 calibrated
-- views of the same object — front / back / left / right) removes the back-of-
-- object hallucination single-image reconstruction is forced into, and the
-- backends we already use (TRELLIS, Hunyuan3D) fuse those views natively.
--
-- These columns capture, per generation: how many views the caller supplied,
-- how many the chosen backend actually fused (they differ when a single-view
-- model is configured and we fall back to the primary view), whether multi-view
-- conditioning was truly used, and which backend handled it. They are surfaced
-- in the submit + poll responses so a downgrade is always reported, never silent.

alter table forge_creations add column if not exists views_requested smallint;
alter table forge_creations add column if not exists views_used      smallint;
alter table forge_creations add column if not exists multiview        boolean;
alter table forge_creations add column if not exists backend          text;
