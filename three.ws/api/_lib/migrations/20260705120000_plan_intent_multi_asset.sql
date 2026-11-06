-- Plan checkout in SOL and $THREE, not just USDC.
--
-- plan_payment_intents was built USDC-only: amount_usdc doubled as both the
-- USD price and the on-chain amount (USDC is 1:1). Paying in SOL or $THREE
-- needs the two separated: the USD value charged stays in amount_usdc, and the
-- exact on-chain amount of the chosen asset (quoted at checkout from the live
-- price) is pinned in amount_asset, with the quote price recorded for audit.
--
-- Idempotent.

BEGIN;

-- Which asset this intent is denominated in. Existing rows are all USDC.
ALTER TABLE plan_payment_intents
    ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'USDC';

-- Exact on-chain amount of `asset` expected, in human units (SOL, $THREE, or
-- USDC). Pinned at checkout so a price move during the session can't change
-- what the user owes. NULL on legacy rows — the USDC paths derive it from
-- amount_usdc.
ALTER TABLE plan_payment_intents
    ADD COLUMN IF NOT EXISTS amount_asset numeric(30, 9);

-- USD price of one unit of `asset` at quote time (audit trail for SOL/$THREE
-- quotes). NULL for USDC (always 1).
ALTER TABLE plan_payment_intents
    ADD COLUMN IF NOT EXISTS asset_price_usd numeric(18, 9);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'plan_payment_intents_asset_check'
    ) THEN
        ALTER TABLE plan_payment_intents
            ADD CONSTRAINT plan_payment_intents_asset_check
            CHECK (asset IN ('USDC', 'SOL', 'THREE'));
    END IF;
END $$;

COMMIT;
