-- Prepaid credit wallet — the platform's spend rail for logged-in users.
--
-- Users top up by depositing SOL or $THREE (verified on-chain by
-- api/_lib/credit-deposit.js) and spend the resulting credits on metered actions
-- (Forge high-tier, …) priced by api/_lib/pricing/catalog.js and discounted by
-- their $THREE holder tier. Credits are denominated in USD (numeric(20,6)) to
-- match the pricing catalog and token_payments.usd — one currency end to end.
--
-- Integrity: credit_accounts holds the rolling balance; credit_ledger is the
-- append-only history. Both are written in ONE statement (a CTE) so a balance
-- change and its ledger row can never diverge. Every movement carries a UNIQUE
-- idempotency_key so a replayed deposit credits once and a replayed charge debits
-- once. A debit only runs `where balance_usd >= amount`, so a spend can never
-- drive the balance negative even under concurrent requests.

create table if not exists credit_accounts (
    user_id                uuid primary key references users(id) on delete cascade,
    balance_usd            numeric(20, 6) not null default 0 check (balance_usd >= 0),
    lifetime_deposited_usd numeric(20, 6) not null default 0,
    lifetime_spent_usd     numeric(20, 6) not null default 0,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create table if not exists credit_ledger (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    -- 'deposit' (on-chain top-up), 'spend' (metered action), 'refund' (failed
    -- action returned), 'grant' (promo/comp), 'adjust' (manual correction).
    kind            text not null check (kind in ('deposit', 'spend', 'refund', 'grant', 'adjust')),
    amount_usd      numeric(20, 6) not null,   -- signed: + credit, - debit
    balance_after   numeric(20, 6) not null,   -- balance immediately after this row
    action          text,                      -- pricing-catalog action id for spends
    ref_type        text,                      -- 'forge' | 'deposit_sol' | 'deposit_three' | …
    ref_id          text,
    tx_signature    text,                      -- on-chain deposit signature (deposits only)
    asset           text,                      -- 'SOL' | 'THREE' for deposits
    asset_amount    numeric(40, 0),            -- atomic amount deposited (lamports / $THREE atomics)
    price_usd       numeric(38, 18),           -- asset USD price at deposit time
    idempotency_key text not null unique,      -- replay guard for deposits AND charges
    meta            jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);

create index if not exists credit_ledger_user_created_idx on credit_ledger (user_id, created_at desc);
create index if not exists credit_ledger_tx_idx on credit_ledger (tx_signature) where tx_signature is not null;
