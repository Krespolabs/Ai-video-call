-- avatar_vrm_compat — VRM 1.0 migration reports per avatar.
--
-- Written by the "VRM 1.0 Compatibility Checker" autonomous x402 pipeline
-- (api/_lib/x402/autonomous-registry.js → entry id 'vrm-compat-checker').
-- Each row is the latest report for one avatar: whether it is a VRM, which
-- spec version, whether a VRM 0.x → 1.0 upgrade is possible, and the
-- migration checklist (spring-bone, expression, MToon, coordinate-flip items)
-- derived from a paid /api/mcp (inspect_model) call's structural report.
--
-- Downstream consumers:
--   • Avatar detail / marketplace gallery → "VRM 1.0 ready" badge + upgrade CTA.
--   • Avatar Pricing Engine pipeline (020) → spec compliance as a pricing input.
CREATE TABLE IF NOT EXISTS avatar_vrm_compat (
	avatar_id      uuid PRIMARY KEY REFERENCES avatars(id) ON DELETE CASCADE,
	source_url     text NOT NULL,
	is_vrm         boolean NOT NULL DEFAULT false,
	vrm_version    text NOT NULL DEFAULT 'none',  -- 'none' | '0.x' | '1.0' | 'unknown'
	upgradeable    boolean,                       -- VRM 0.x → 1.0 feasible; null when N/A
	blocker_count  int NOT NULL DEFAULT 0,        -- migration items needing manual review
	issues         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- flagged incompatibilities
	report         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- full migration report
	extensions     text[] NOT NULL DEFAULT '{}',  -- glTF extensionsUsed snapshot
	run_id         uuid,
	tx_signature   text,
	checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS avatar_vrm_compat_version_idx ON avatar_vrm_compat (vrm_version);
CREATE INDEX IF NOT EXISTS avatar_vrm_compat_upgradeable_idx ON avatar_vrm_compat (upgradeable) WHERE upgradeable IS TRUE;
CREATE INDEX IF NOT EXISTS avatar_vrm_compat_checked_idx ON avatar_vrm_compat (checked_at);
