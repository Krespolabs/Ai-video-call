-- Multi-collaborator payment splits for marketplace listings.
--
-- A listing (an agent's paid skill) may credit more than one collaborator. The
-- split config lives here; the per-purchase apportionment is recorded in
-- split_distributions so every recipient's exact share is auditable and, in
-- ledger mode, withdrawable. On-chain (0xSplits, EVM) splits store the contract
-- address; the creator-net flows into it on chain and 0xSplits distributes.
-- Single-creator listings have NO row here and pay the creator directly.

CREATE TABLE IF NOT EXISTS listing_splits (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	agent_id      uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
	skill         text NOT NULL,
	chain         text NOT NULL DEFAULT 'solana',
	-- 0xSplits contract address when anchored on chain; NULL ⇒ ledger mode.
	split_address text,
	split_mode    text NOT NULL DEFAULT 'ledger' CHECK (split_mode IN ('ledger', 'onchain')),
	-- Owner of a mutable split (can update recipients); NULL ⇒ immutable.
	owner_address text,
	created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
	created_at    timestamptz NOT NULL DEFAULT now(),
	updated_at    timestamptz NOT NULL DEFAULT now(),
	UNIQUE (agent_id, skill)
);

CREATE TABLE IF NOT EXISTS listing_split_recipients (
	id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	split_id          uuid NOT NULL REFERENCES listing_splits(id) ON DELETE CASCADE,
	recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
	address           text NOT NULL,
	chain             text NOT NULL,
	-- Share in basis points; the application enforces Σ share_bps = 10000.
	share_bps         integer NOT NULL CHECK (share_bps > 0 AND share_bps <= 10000),
	label             text,
	created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_split_recipients_split ON listing_split_recipients(split_id);

-- How a confirmed purchase's creator-net was divided. One row per recipient.
-- Unique on (purchase_id, address) so a retried confirm is idempotent — a
-- recipient is credited for a purchase at most once.
CREATE TABLE IF NOT EXISTS split_distributions (
	id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	purchase_id       uuid NOT NULL REFERENCES skill_purchases(id) ON DELETE CASCADE,
	split_id          uuid NOT NULL REFERENCES listing_splits(id) ON DELETE CASCADE,
	recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
	address           text NOT NULL,
	share_bps         integer NOT NULL,
	amount            bigint NOT NULL CHECK (amount >= 0),  -- atomic units
	currency_mint     text NOT NULL,
	chain             text NOT NULL,
	-- onchain: net flowed into the 0xSplits contract (settled on chain).
	-- ledger:  platform-recorded credit the recipient withdraws.
	mode              text NOT NULL DEFAULT 'ledger' CHECK (mode IN ('ledger', 'onchain')),
	status            text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'settled', 'failed')),
	tx_signature      text,
	created_at        timestamptz NOT NULL DEFAULT now(),
	UNIQUE (purchase_id, address)
);
CREATE INDEX IF NOT EXISTS idx_split_dist_recipient ON split_distributions(recipient_user_id, status);
CREATE INDEX IF NOT EXISTS idx_split_dist_purchase ON split_distributions(purchase_id);
