-- Model categories: classify what a 3D model IS, not just how it was created.
-- This powers category browsing everywhere models are displayed and lays the
-- groundwork for an agent equipment / accessory system.
--
-- Categories:
--   avatar      — full character/agent body (default for existing records)
--   accessory   — wearable/equippable item for an agent
--   item        — prop or object an agent can hold or interact with
--   scene       — environment, world, or background scene
--   creature    — animal, pet, or non-humanoid companion
--   vehicle     — vehicle or mount
--   other       — uncategorised

ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS model_category text NOT NULL DEFAULT 'avatar'
    CHECK (model_category IN ('avatar','accessory','item','scene','creature','vehicle','other'));

ALTER TABLE forge_creations
  ADD COLUMN IF NOT EXISTS model_category text NOT NULL DEFAULT 'other'
    CHECK (model_category IN ('avatar','accessory','item','scene','creature','vehicle','other'));

-- Index for category-filtered listing queries on both tables.
CREATE INDEX IF NOT EXISTS idx_avatars_model_category
  ON avatars (model_category)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_forge_creations_model_category
  ON forge_creations (model_category);
