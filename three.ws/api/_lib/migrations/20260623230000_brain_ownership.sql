-- Portable & Verifiable Brain — own your agent's mind (Living Agents · Task 06).
--
-- Three additive concerns, all idempotent so a clean-room bootstrap from
-- schema.sql and an incremental apply land in the same place:
--
--   1. Per-memory authorship + integrity. Every memory an agent commits is
--      signed by the agent's own EVM wallet (ERC-191) over a canonical hash of
--      its content. content_hash is the fast tamper check; signature +
--      signer_address are the publicly-verifiable proof of authorship. A buyer
--      or forker re-derives the hash and ecrecovers the signer offline — no
--      trust in our DB required.
--
--   2. Per-memory storage mode + IPFS provenance. storage_mode overrides the
--      agent's default (null = inherit). ipfs_cid records where an encrypted or
--      pinned copy lives (the CID is also tracked in agent_memory_pins for
--      ownership). Private memories pinned in encrypted-ipfs mode are encrypted
--      client-side with the owner's wallet-derived key — we store the ciphertext
--      CID, never plaintext.
--
--   3. Brain anchors. Each anchored milestone is a row: a content-addressed
--      brain_hash (persona version + sorted memory content-hashes) recorded on
--      the ERC-8004 ValidationRegistry. The table is the agent's verifiable
--      proof-of-growth history — one row per anchor, including failed attempts
--      with their reason, so an anchor is never silently skipped.

-- 1 + 2 — agent_memories authorship + storage columns
alter table agent_memories add column if not exists content_hash   text;
alter table agent_memories add column if not exists signature       text;
alter table agent_memories add column if not exists signer_address  text;
alter table agent_memories add column if not exists signed_at       timestamptz;
alter table agent_memories add column if not exists storage_mode    text;
alter table agent_memories add column if not exists ipfs_cid        text;

alter table agent_memories drop constraint if exists agent_memories_storage_mode_chk;
alter table agent_memories add constraint agent_memories_storage_mode_chk
    check (storage_mode is null or storage_mode in ('local','ipfs','encrypted-ipfs','none'));

-- Per-agent default storage mode for new memories.
alter table agent_identities add column if not exists memory_storage_mode text not null default 'local';

alter table agent_identities drop constraint if exists agent_identities_memory_storage_mode_chk;
alter table agent_identities add constraint agent_identities_memory_storage_mode_chk
    check (memory_storage_mode in ('local','ipfs','encrypted-ipfs','none'));

-- 3 — brain anchor history
create table if not exists agent_brain_anchors (
    id                  uuid primary key default gen_random_uuid(),
    agent_id            uuid not null references agent_identities(id) on delete cascade,
    brain_hash          text not null,                       -- sha256 over persona hash + sorted memory hashes
    kind                text not null default 'threews.brain-anchor.v1',
    status              text not null default 'pending'
                            check (status in ('pending','anchored','failed')),
    proof_uri           text,                                -- pinned brain passport JSON
    proof_hash          text,                                -- keccak/sha of the pinned proof bytes
    tx_hash             text,                                -- on-chain recordValidation tx
    chain_id            integer,
    erc8004_agent_id    bigint,
    memory_count        integer not null default 0,
    public_count        integer not null default 0,
    persona_prompt_hash text,
    signer_address      text,                                -- agent wallet that signed brain_hash
    signature           text,                                -- ERC-191 signature over brain_hash
    error_code          text,                                -- machine-readable reason when status='failed'
    error_detail        text,
    created_at          timestamptz not null default now(),
    anchored_at         timestamptz
);

create index if not exists agent_brain_anchors_agent
    on agent_brain_anchors(agent_id, created_at desc);
create index if not exists agent_brain_anchors_hash
    on agent_brain_anchors(agent_id, brain_hash);
create index if not exists agent_brain_anchors_status
    on agent_brain_anchors(agent_id, status, created_at desc);
