begin;

-- IRL Money Drops & Bounties (Agent Wallets Wave II — task 06).
-- ============================================================================
-- Value placed in the real world. A creator (a user, or an agent owner arming a
-- bounty) locks REAL SOL/USDC/$THREE into a freshly generated, single-purpose
-- escrow wallet anchored to a physical location. Whoever PHYSICALLY walks up to
-- that spot — proven by the same proof-of-presence fix token the IRL nearby read
-- already enforces (api/_lib/irl-presence.js) — and is inside the radius can claim
-- a share to their own wallet. Unclaimed drops auto-refund the creator on expiry.
--
-- Custody model (real, audited, honest):
--   • Each drop owns a fresh Solana keypair (the escrow). Its secret is sealed at
--     rest with secret-box (AES-256-GCM, api/_lib/secret-box.js) and decrypted
--     ONLY to sign a verified claim release or an expiry refund.
--   • Funding is the creator's OWN signed transfer (visitor wallet via
--     src/shared/agent-tip.js, or an agent's custodial wallet for owner-armed
--     bounties) into the escrow address, then CONFIRMED on-chain before the drop
--     is ever shown as claimable (status pending_funding -> active). No fake balances.
--   • Releases + refunds are server-signed by the escrow key with the platform
--     funding wallet as fee-payer (same rail as sealed-drop-funding.js); the escrow
--     holds EXACTLY total_atomics, the platform pays network fees + ATA rent.
--   • Every move writes an agent_custody_events row (audit trail + spend ledger).
--
-- Concurrency: a claim acquires pg_advisory_xact_lock(drop id) and increments
-- claims_count under it, so two people racing the last slot are serialized and
-- only one wins. A partial-unique index makes a claim idempotent per claimant.

create table if not exists irl_drops (
    id                  uuid         primary key default gen_random_uuid(),

    -- creator identity: a user, an anonymous device, and/or an agent owner.
    creator_user_id     uuid,                                   -- authenticated owner (null = anon device)
    creator_device      text,                                   -- anonymous IRL device token
    creator_agent_id    uuid         references agent_identities(id) on delete set null, -- agent that armed a bounty

    kind                text         not null default 'drop'    check (kind in ('drop','bounty')),
    asset               text         not null                   check (asset in ('SOL','USDC','THREE')),
    amount_atomics      numeric(40,0) not null                  check (amount_atomics > 0),  -- per-claim payout
    max_claims          integer      not null default 1         check (max_claims >= 1 and max_claims <= 1000),
    claim_rule          text         not null default 'first'   check (claim_rule in ('first','each-once','quiz')),
    total_atomics       numeric(40,0) not null                  check (total_atomics > 0),   -- amount * max_claims (funded requirement)

    -- bounty completion condition (null for a plain location drop).
    bounty_condition    text                                    check (bounty_condition in ('presence','chat','quiz')),
    quiz_question       text,
    quiz_answer_hash    text,                                   -- sha256(normalized answer); plaintext is NEVER stored

    title               text,
    note                text,

    -- physical anchor.
    lat                 double precision not null,
    lng                 double precision not null,
    radius_m            double precision not null default 30    check (radius_m >= 5 and radius_m <= 250),
    geocell7            text         not null,                   -- ~153 m geohash, the nearby index

    -- escrow custody.
    escrow_address      text         not null,
    escrow_secret_enc   text         not null,                  -- secret-box ciphertext, decrypted only to sign
    refund_address      text,                                   -- where an expiry/cancel refund is swept
    network             text         not null default 'mainnet' check (network in ('mainnet','devnet')),

    status              text         not null default 'pending_funding'
        check (status in ('pending_funding','active','exhausted','expired','refunded','cancelled')),
    funding_tx          text,
    funded_atomics      numeric(40,0) not null default 0,
    refund_tx           text,

    claims_count        integer      not null default 0         check (claims_count >= 0),

    expires_at          timestamptz  not null,
    created_at          timestamptz  not null default now(),
    updated_at          timestamptz  not null default now(),
    funded_at           timestamptz,
    refunded_at         timestamptz
);

-- Nearby read: by geocell, only the drops that can still pay out. The presence
-- token already binds the caller to a coarse cell, so this index serves the
-- "what live drops are around me" query directly.
create index if not exists irl_drops_cell_active
    on irl_drops (geocell7)
    where status in ('active','exhausted');

create index if not exists irl_drops_creator
    on irl_drops (creator_user_id, created_at desc)
    where creator_user_id is not null;

create index if not exists irl_drops_creator_device
    on irl_drops (creator_device, created_at desc)
    where creator_device is not null;

-- Expiry sweep cursor: active/exhausted drops past their expiry that still hold
-- funds and need an auto-refund.
create index if not exists irl_drops_expiry
    on irl_drops (expires_at)
    where status in ('active','exhausted','pending_funding');

comment on table irl_drops is
    'IRL money drops + bounties (agent-wallets-ii task 06). A drop locks real '
    'SOL/USDC/$THREE in a per-drop escrow wallet anchored to a physical location; '
    'a presence-proven claimant inside the radius claims a share to their own '
    'wallet; unclaimed drops auto-refund the creator on expiry. escrow_secret_enc '
    'is secret-box ciphertext decrypted only to sign a verified release/refund.';

create table if not exists irl_drop_claims (
    id                  bigserial    primary key,
    drop_id             uuid         not null references irl_drops(id) on delete cascade,

    claimant_user_id    uuid,
    claimant_device     text,
    claimant_key        text         not null,                  -- stable per-claimant identity (user id or device)
    claim_wallet        text         not null,                  -- destination of the released funds

    amount_atomics      numeric(40,0) not null,
    asset               text         not null,
    signature           text,                                   -- on-chain release tx
    status              text         not null default 'pending' check (status in ('pending','confirmed','failed')),

    created_at          timestamptz  not null default now(),
    confirmed_at        timestamptz
);

-- One LIVE claim per claimant per drop (idempotent claim, no double-claim). A
-- failed attempt does not occupy the slot, so a claimant can retry after an RPC
-- blip without being permanently locked out.
create unique index if not exists irl_drop_claims_one_per_claimant
    on irl_drop_claims (drop_id, claimant_key)
    where status in ('pending','confirmed');

create index if not exists irl_drop_claims_drop
    on irl_drop_claims (drop_id, created_at desc);

create index if not exists irl_drop_claims_wallet
    on irl_drop_claims (claim_wallet, created_at desc);

comment on table irl_drop_claims is
    'Per-claim ledger for irl_drops. A claim is reserved (pending) under an '
    'advisory lock on the drop, then confirmed once the real escrow release lands '
    'on-chain (signature). The partial-unique index enforces one live claim per '
    'claimant per drop; failed attempts free the slot for a clean retry.';

commit;
