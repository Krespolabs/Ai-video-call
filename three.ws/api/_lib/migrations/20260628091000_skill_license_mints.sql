-- On-chain skill-license issuance log.
--
-- One row per confirmed purchase that attempted an on-chain license mint (the
-- `skill_license` Anchor program). Records the minted PDA / NFT / tx so the
-- creator dashboard can show a license count and the skill executor can read a
-- proof, and records `skipped` (with a reason) when the environment can't mint
-- — so a missing collection / minter key / wallet is observable, never silent.

CREATE TABLE IF NOT EXISTS skill_license_mints (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	purchase_id   uuid NOT NULL REFERENCES skill_purchases(id) ON DELETE CASCADE,
	user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
	agent_id      uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
	skill         text NOT NULL,
	owner_wallet  text,
	agent_mint    text,
	network       text,
	program_id    text,
	license_pda   text,
	nft_mint      text,
	tx_signature  text,
	-- minted: newly minted; already: PDA existed; skipped: env can't mint (reason set).
	status        text NOT NULL DEFAULT 'skipped' CHECK (status IN ('minted', 'already', 'skipped')),
	reason        text,
	created_at    timestamptz NOT NULL DEFAULT now(),
	updated_at    timestamptz NOT NULL DEFAULT now(),
	UNIQUE (purchase_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_license_mints_agent ON skill_license_mints(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_license_mints_user ON skill_license_mints(user_id);
