-- x402 Merchant Console — charity + round-up giving.
--
-- Two opt-in giving primitives layered on top of a merchant's settled payments:
--
--   charity  — a fixed share (basis points) of every settled payment is earmarked
--              for a cause wallet. Surfaced to buyers on the hosted checkout +
--              storefront so a paid call doubles as a donation.
--   round-up — the buyer-facing total is rounded UP to the nearest unit (e.g. the
--              next whole USDC) and the difference goes to the same cause wallet.
--              Opt-in, shown explicitly before the buyer signs.
--
-- Both are config only here; the hosted checkout reads them from the public
-- storefront payload and the merchant's own embeds honour them client-side. The
-- cause address is validated against its declared chain in the API layer.

ALTER TABLE x402_merchant_settings
    ADD COLUMN IF NOT EXISTS charity_enabled  boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS charity_name     text,
    ADD COLUMN IF NOT EXISTS charity_chain    text
        CHECK (charity_chain IS NULL OR charity_chain IN ('base', 'solana')),
    ADD COLUMN IF NOT EXISTS charity_address  text,
    ADD COLUMN IF NOT EXISTS charity_bps      int  NOT NULL DEFAULT 0
        CHECK (charity_bps BETWEEN 0 AND 10000),
    ADD COLUMN IF NOT EXISTS roundup_enabled  boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS roundup_to_atomics text;   -- round buyer total up to nearest multiple (raw token units)
