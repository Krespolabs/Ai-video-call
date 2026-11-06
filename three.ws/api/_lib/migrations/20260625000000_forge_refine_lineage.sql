begin;

-- Forge conversational refinement + remix provenance
-- ===================================================
-- Adds the columns needed to record that a forge_creation was produced by
-- refining or remixing an earlier one:
--
--   parent_creation_id   — the creation this was derived from (UUID foreign key).
--                          NULL for original (non-derived) generations.
--   refine_instruction   — the natural-language change the user requested, e.g.
--                          "make it metallic". Stored verbatim (not the composed
--                          prompt — the composed prompt is still in `prompt`).
--   lineage_index        — this version's position in the conversation thread
--                          (0 = origin, 1 = first refinement, …). Combined with
--                          parent_creation_id, a full tree can be reconstructed.
--   remixable            — true when the creator opts this model into the
--                          remix bazaar. Only 'done' rows with a stored GLB are
--                          ever surfaced by api/remix-feed.js.
--   remix_royalty_bps    — the creator-set royalty rate in basis points (0–2000).
--                          Stored here so it travels with the record at the time
--                          a remix is initiated; changing it later does not
--                          retroactively alter in-flight remix payments. Capped
--                          and enforced in api/_lib/remix-royalty.js.
--   creator_wallet_solana — the Solana wallet address to receive remix royalties.
--                          May be set server-side from the authenticated session;
--                          never required for the free lane.
--   remix_settlement_ref — the last royalty settlement reference for this row as
--                          a REMIX SOURCE (i.e. when another creation derived
--                          from it and the royalty transfer completed). Stored as
--                          JSONB so it can carry { tx_signature, usdc_atomics,
--                          settled_at, remix_creation_id }.

alter table forge_creations
    add column if not exists parent_creation_id    uuid        references forge_creations(id) on delete set null,
    add column if not exists refine_instruction    text,
    add column if not exists lineage_index         integer     not null default 0,
    add column if not exists remixable             boolean     not null default false,
    add column if not exists remix_royalty_bps     integer     not null default 1000
                                                   check (remix_royalty_bps >= 0 and remix_royalty_bps <= 2000),
    add column if not exists creator_wallet_solana text,
    add column if not exists remix_settlement_ref  jsonb;

-- Walk the parent chain for a thread view (e.g. getLineage).
create index if not exists forge_creations_parent
    on forge_creations (parent_creation_id)
    where parent_creation_id is not null;

-- Power the remix feed: done, stored, opted-in models only.
create index if not exists forge_creations_remixable
    on forge_creations (created_at desc)
    where remixable = true and status = 'done' and glb_url is not null;

comment on column forge_creations.parent_creation_id is
    'The creation this was derived from via refine_model or remix. NULL for '
    'original (non-derived) generations.';
comment on column forge_creations.refine_instruction is
    'The raw user instruction that produced this refinement ("make it metallic"). '
    'The composed prompt (parent prompt + instruction) is stored in the `prompt` '
    'column as usual.';
comment on column forge_creations.lineage_index is
    'Position in the conversational thread: 0 = origin, 1 = first refinement, …. '
    'Depth in the tree, not a global sequence — two branches from the same parent '
    'can share a lineage_index. Use parent_creation_id to reconstruct the full tree.';
comment on column forge_creations.remixable is
    'True when the creator has opted this model into the remix bazaar. The feed '
    '(api/remix-feed.js) only surfaces done rows with a stored GLB and this flag.';
comment on column forge_creations.remix_royalty_bps is
    'Creator-set royalty rate (0–2000 bps = 0–20%). Clamped at write time. '
    'Snapshot in api/x402/remix-asset.js at the moment the remix is paid.';
comment on column forge_creations.creator_wallet_solana is
    'Solana wallet address for remix royalty payouts (set from authenticated '
    'session; never required on the free lane).';
comment on column forge_creations.remix_settlement_ref is
    'JSONB record of the last royalty settlement on this creation as a remix '
    'SOURCE: { tx_signature, usdc_atomics, settled_at, remix_creation_id }.';

commit;
