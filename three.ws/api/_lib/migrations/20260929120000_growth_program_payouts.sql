-- Trading growth programs: the ledger behind the two $THREE payout programs
-- (the first-rug softener and the early-leader bonus, docs/growth-programs.md).
-- Apply: npm run db:status, then npm run db:migrate. Idempotent and additive.
--
-- One row is one payout the platform has committed to: a first-timer's claim
-- against their first rug, or an early leader's enrollment bonus. Both programs
-- ship disarmed, so in production this table stays empty until the owner arms
-- one. The dry-run reports compute everything from source data and never write
-- here.
--
-- The uniqueness rules ARE the anti-sybil backstop, enforced by the database
-- rather than by application code that a race could slip past:
--   (program, subject_key)       one payout per position (rug) or per agent (leader)
--   (program, user_id)           one payout per account per program
--   (program, recipient_wallet)  one payout per receiving wallet per program
--
-- Status lifecycle:
--   claimed   recorded, waiting for the payout cron (rug softener claims start here)
--   sending   the cron has claimed the row and is about to transfer. A row left
--             in 'sending' (a crash between claim and confirm) is NEVER retried
--             automatically: it is reconciled by hand against the chain, so a
--             crash can never turn into a double payment.
--   sent      the transfer landed; tx_signature holds it
--   failed    the transfer threw; note says why. Eligible for retry.
--   blocked   refused by a guard (cap, missing key, invalid wallet); note says why.
--
-- usd_value is what the payout was worth at the price it was quoted at, and is
-- what the per-period caps sum over.

begin;

create table if not exists growth_program_payouts (
    id               uuid primary key default gen_random_uuid(),
    program          text not null check (program in ('rug_softener', 'early_leader')),
    subject_key      text not null,
    user_id          uuid,
    agent_id         uuid,
    position_id      uuid,
    recipient_wallet text not null,
    usd_value        numeric(18, 6) not null check (usd_value >= 0),
    amount_atomics   numeric(40, 0),
    price_usd        numeric(30, 12),
    price_source     text,
    basis            jsonb not null default '{}'::jsonb,
    status           text not null default 'claimed'
                     check (status in ('claimed', 'sending', 'sent', 'failed', 'blocked')),
    tx_signature     text,
    note             text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    sent_at          timestamptz
);

create unique index if not exists growth_program_payouts_subject_uniq
    on growth_program_payouts (program, subject_key);

create unique index if not exists growth_program_payouts_user_uniq
    on growth_program_payouts (program, user_id)
    where user_id is not null;

create unique index if not exists growth_program_payouts_wallet_uniq
    on growth_program_payouts (program, recipient_wallet);

create unique index if not exists growth_program_payouts_tx_uniq
    on growth_program_payouts (tx_signature)
    where tx_signature is not null;

-- The payout cron's work queue and the cap sums both read by program + status.
create index if not exists growth_program_payouts_queue
    on growth_program_payouts (program, status, created_at);

commit;
