-- Bundle purchases must be verified on-chain at confirm, exactly like single-skill
-- purchases. That requires persisting the Solana-Pay reference minted at create
-- (to locate the tx), the treasury fee wallet (to verify the fee leg), and the
-- mint decimals (to convert atomic price → UI amount for validateTransfer).
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260621121000_bundle-purchase-verify.sql
-- Idempotent.

begin;

alter table bundle_purchases add column if not exists reference           text;
alter table bundle_purchases add column if not exists platform_fee_wallet text;
alter table bundle_purchases add column if not exists mint_decimals       int not null default 6;

-- The Solana-Pay reference is unique per pending purchase and is how confirm
-- finds the on-chain tx; index it for the lookup.
create index if not exists idx_bundle_purchases_reference
    on bundle_purchases(reference) where reference is not null;

commit;
