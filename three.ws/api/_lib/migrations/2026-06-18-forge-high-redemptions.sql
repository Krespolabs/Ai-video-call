-- Migration: forge_high_redemptions — single-use ledger for pay-per-use Forge High.
-- Apply: node scripts/apply-migrations.mjs --apply --file 2026-06-18-forge-high-redemptions.sql
-- Idempotent.
--
-- Token Utility — the consumption lever. A non-holder can pay $THREE per High
-- generation instead of holding (api/_lib/token quote → settle records the
-- payment in token_payments). This table binds ONE settled `consumption` payment
-- to ONE High generation: the PRIMARY KEY on payment_id is the source of truth
-- for "one payment = one generation". A second redemption of the same payment_id
-- violates it and is surfaced as payment_already_used.
--
-- The row is written only when a generation is actually dispatched. If the
-- generation fails before dispatch (validation, moderation, rate limit) or the
-- provider call itself throws, the claim is released (row deleted) so the settled
-- payment stays reusable on retry — the user never loses a payment to a failure
-- that produced no model. Both timestamps are kept for audit/reconciliation.
--
-- No secrets are stored: payment_id references the public token_payments ledger.

begin;

create table if not exists forge_high_redemptions (
    -- The settled consumption payment redeemed (one row per payment, ever).
    payment_id   uuid primary key references token_payments(id) on delete cascade,
    -- The client nonce the payment was quoted/settled against (token_payments.ref_id).
    -- Re-checked at redemption so possession of payment_id alone can't redeem.
    ref_id       text not null,
    -- The forge job/creation the redemption funded (audit link; null for sync lanes
    -- that complete inside the request before a handle exists).
    job_id       text,
    -- When the underlying payment settled on-chain (copied from token_payments) and
    -- when it was redeemed here — both kept so a redemption is fully reconcilable.
    settled_at   timestamptz,
    redeemed_at  timestamptz not null default now()
);

create index if not exists forge_high_redemptions_redeemed
    on forge_high_redemptions (redeemed_at desc);

commit;
