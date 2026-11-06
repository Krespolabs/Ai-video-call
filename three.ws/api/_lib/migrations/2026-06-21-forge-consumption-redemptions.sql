-- Migration: forge_consumption_redemptions — single-use ledger for pay-per-use
-- Forge consumption actions beyond High (Game-Ready export today; future actions
-- next).
-- Apply: node scripts/apply-migrations.mjs --apply --file 2026-06-21-forge-consumption-redemptions.sql
-- Idempotent.
--
-- Token Utility — the consumption lever, generalized. A non-holder can pay $THREE
-- per dispatch of a priced Forge action instead of holding (api/_lib/token quote →
-- settle records the payment in token_payments). This table binds ONE settled
-- `consumption` payment to ONE dispatch: the PRIMARY KEY on payment_id is the
-- source of truth for "one payment = one dispatch", GLOBAL across actions — a
-- second redemption of the same payment_id (for any action) violates it and is
-- surfaced as payment_already_used. `action` records which catalog action the
-- payment funded, for audit/reconciliation; it is NOT part of the uniqueness key.
--
-- forge.high keeps its own dedicated forge_high_redemptions ledger (already shipped
-- and tested); this is the additive home for every other Forge consumption action,
-- so monetizing a new one never touches the High path.
--
-- The row is written only when a dispatch is actually started. If it fails before
-- dispatch (validation, rate limit, unconfigured worker) or the provider call
-- itself throws, the claim is released (row deleted) so the settled payment stays
-- reusable on retry — the user never loses a payment to a failure that produced no
-- deliverable. Both timestamps are kept for audit/reconciliation.
--
-- No secrets are stored: payment_id references the public token_payments ledger.

begin;

create table if not exists forge_consumption_redemptions (
    -- The settled consumption payment redeemed (one row per payment, ever, across
    -- every action).
    payment_id   uuid primary key references token_payments(id) on delete cascade,
    -- The catalog action this payment funded (e.g. 'forge.gameready'). Audit only —
    -- single-use is enforced by the payment_id PRIMARY KEY, not by (payment_id, action).
    action       text not null,
    -- The client nonce the payment was quoted/settled against (token_payments.ref_id).
    -- Re-checked at redemption so possession of payment_id alone can't redeem.
    ref_id       text not null,
    -- The job/creation the redemption funded (audit link; null for sync lanes that
    -- complete inside the request before a handle exists).
    job_id       text,
    -- When the underlying payment settled on-chain (copied from token_payments) and
    -- when it was redeemed here — both kept so a redemption is fully reconcilable.
    settled_at   timestamptz,
    redeemed_at  timestamptz not null default now()
);

create index if not exists forge_consumption_redemptions_redeemed
    on forge_consumption_redemptions (redeemed_at desc);

create index if not exists forge_consumption_redemptions_action
    on forge_consumption_redemptions (action);

commit;
