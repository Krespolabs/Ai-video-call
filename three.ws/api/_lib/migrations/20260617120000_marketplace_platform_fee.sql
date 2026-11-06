-- Platform fee on marketplace skill purchases.
--
-- A small, configurable percentage of every paid skill purchase is split off
-- on-chain to the platform treasury wallet in the SAME transaction the buyer
-- signs (Solana). The fee comes OUT of the listed price — the buyer pays the
-- price, the creator receives (price - fee), and the treasury receives the fee.
-- There is no custody: one signed transaction settles both legs atomically.
--
-- The fee amount + destination are computed server-side at purchase-create time
-- and persisted here so the confirm step verifies the EXACT split that was
-- quoted, even if the fee configuration changes between create and confirm.

ALTER TABLE skill_purchases
  ADD COLUMN IF NOT EXISTS platform_fee_amount BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS platform_fee_wallet TEXT;

-- Immutable per-purchase record of what the platform actually collected, so
-- admin/creator revenue reporting can separate platform fee income from the
-- creator's net and from referral commission (which stays in fee_amount).
ALTER TABLE agent_revenue_events
  ADD COLUMN IF NOT EXISTS platform_fee_amount BIGINT NOT NULL DEFAULT 0;
