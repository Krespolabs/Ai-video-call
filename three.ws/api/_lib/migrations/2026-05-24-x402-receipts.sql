-- Migration: durable log of x402 offer-receipt artifacts (USE-17).
-- Apply: npm run db:migrate -- --apply --file 2026-05-24-x402-receipts.sql
-- Idempotent.
--
-- Every successful paid /api/x402/* call writes one row here: the signed
-- receipt we returned in the SettlementResponse, the resource it covered, the
-- payer wallet, and the chain network. Buyers can later query their own
-- receipts via /api/x402/my-receipts (gated by a buyer-signed message so only
-- the wallet that received the receipt can list it).
--
-- Stored as JSONB so verifiers don't have to reconstruct the wire shape —
-- they can pull the exact signed artifact and run verifyReceiptSignatureEIP712
-- against it.

begin;

create table if not exists x402_receipts (
    id           uuid        primary key default gen_random_uuid(),
    payer        text        not null,
    network      text        not null,
    resource_url text        not null,
    format       text        not null,
    receipt      jsonb       not null,
    transaction  text,
    issued_at    timestamptz not null default now()
);

-- Primary query path: buyer asks "show me my receipts since timestamp X".
-- payer is lower-cased on insert so address-format comparisons stay stable
-- across EVM checksummed / non-checksummed shapes.
create index if not exists x402_receipts_payer_issued
    on x402_receipts (payer, issued_at desc);

create index if not exists x402_receipts_resource_issued
    on x402_receipts (resource_url, issued_at desc);

commit;
