begin;

-- Verifiable Proof-of-Custody — on-chain-anchored attestation of every custodial
-- agent wallet's state.
--
-- On a schedule (api/cron/custody-attest.js) the platform snapshots each
-- custodial Solana wallet's *public* facts — address, live on-chain balance, and
-- a commitment to its authorized-state head from agent_custody_events — builds a
-- Merkle tree over all wallets, and commits the root on-chain (SPL Memo). Owners
-- get a per-wallet inclusion proof they verify themselves in the browser against
-- the on-chain root. No secrets, no cross-tenant data: every column here is
-- public or owner-authorized.
--
-- Leaf encoding + tree construction are pinned by src/proof-of-custody/merkle.js
-- (the one module both the server prover and the browser verifier import) and by
-- tests/custody-merkle.test.js. Do not recompute hashes anywhere else.

-- One row per attestation round. `epoch` is strictly monotonic (rollback/replay
-- is therefore obvious — an owner verifies the latest and can walk back). The
-- Merkle root and the on-chain anchor tx are public.
create table if not exists custody_attestation_epochs (
    epoch          bigint       primary key,          -- monotonic round number, starts at 1
    network        text         not null,             -- network the balances were read from
    anchor_network text,                              -- network the root memo was committed on
    merkle_root    text         not null,             -- 64-char hex sha256 Merkle root
    wallet_count   integer      not null default 0,   -- leaves in the tree
    total_lamports numeric      not null default 0,   -- aggregate SOL across wallets (public)
    anchor_sig     text,                              -- on-chain memo tx signature (null until anchored)
    anchor_status  text         not null default 'pending', -- pending | anchored | anchor_failed
    anchor_error   text,                              -- last anchor failure reason (operator-facing)
    snapshot_ms    integer,                           -- how long the snapshot took (telemetry)
    created_at     timestamptz  not null default now(),
    anchored_at    timestamptz                        -- when the root landed on-chain
);

create index if not exists custody_attestation_epochs_created
    on custody_attestation_epochs (created_at desc);

create index if not exists custody_attestation_epochs_anchored
    on custody_attestation_epochs (anchor_status, epoch desc);

-- One row per wallet per epoch — the leaves of that epoch's Merkle tree, in
-- tree order (`leaf_index`). Stores ONLY the public/owner-authorized facts that
-- go into the leaf hash, so a per-owner inclusion proof can be rebuilt on demand
-- (load the epoch's leaves → reconstruct tree → emit path) without ever exposing
-- another owner's leaf: the inclusion-proof endpoint is ownership-gated and the
-- public integrity page reads only the epochs table aggregates.
create table if not exists custody_attestation_leaves (
    epoch          bigint       not null references custody_attestation_epochs(epoch) on delete cascade,
    leaf_index     integer      not null,             -- position in the ordered tree
    agent_id       uuid         not null,
    address        text         not null,             -- custodial Solana address (base58, public)
    balance_lamports numeric    not null,             -- on-chain balance at snapshot (lamports)
    ledger_head    text         not null,             -- authorized-state commitment ("<id>:<sig>" | "genesis")
    leaf_hash      text         not null,             -- 64-char hex sha256 leaf hash
    created_at     timestamptz  not null default now(),
    primary key (epoch, leaf_index)
);

-- The inclusion-proof endpoint looks a wallet up by (epoch, agent_id).
create index if not exists custody_attestation_leaves_agent
    on custody_attestation_leaves (agent_id, epoch desc);

create index if not exists custody_attestation_leaves_epoch
    on custody_attestation_leaves (epoch, leaf_index);

comment on table custody_attestation_epochs is
    'Proof-of-Custody attestation rounds: monotonic epoch, Merkle root over all '
    'custodial wallets, and the on-chain anchor tx. Public face at /integrity.';
comment on table custody_attestation_leaves is
    'Per-wallet leaves of each epoch''s Merkle tree (public facts only). Backs the '
    'owner-gated inclusion proof at GET /api/agents/:id/solana/proof. Rebuild the '
    'tree from these to emit a path; never expose another owner''s leaf.';

commit;
