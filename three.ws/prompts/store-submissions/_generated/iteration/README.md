# Prompt 09 — Conversational, remixable 3D: verification evidence

Captured 2026-07-07 against production (`https://three.ws`). Everything here is a
real generation on the live pipeline — no mocks, no fake data.

## A. Conversational iteration (free + paid tracks)

`refine_model` folds a natural-language change into the parent prompt
(`composeRefinement`) and runs a REAL re-generation anchored to the prior model,
recording every version in an immutable lineage. Available:

- **Free** on the OpenAI-track studio `/api/mcp-studio` (`refine_model` tool) —
  zero payment/crypto surface.
- **Paid** on the stdio MCP server `3d-agent-local` (`refine_model`, $0.25 USDC).

### Real generations (origin + 2 refinements)

Each row is a live `POST https://three.ws/api/forge`, HTTP 200, a durable GLB on
R2. Byte sizes differ → visibly different meshes.

| Version | Instruction | Composed prompt (what the generator ran) | creation_id | GLB size |
|---|---|---|---|---|
| 0 (origin) | — | `a friendly round robot mascot, glossy white plastic` | `d6892889…` | 1,224,928 B |
| 1 | make it metallic and gold | `… glossy white plastic, metallic and gold` | `481ff3ff…` | 1,503,832 B |
| 2 | add glowing blue eyes and antenna | `… metallic and gold, add glowing blue eyes and antenna` | `764e1e9d…` | 1,629,684 B |

GLBs:
- v0 https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/d6892889-ca6b-4d77-8ffc-638a60002b15.glb
- v1 https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/481ff3ff-db68-467a-b4be-47fa901bb664.glb
- v2 https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/764e1e9d-f308-49d1-9689-7855bdb6f7c5.glb

Raw responses: `origin-submit.json`, `refine-1-submit.json`, `refine-2-submit.json`.

### The `refine_model` tool, live end-to-end (not just the pipeline)

`studio-refine_model-live.json` is the actual free-studio tool driven through its
dispatcher against prod (`STUDIO_API_BASE=https://three.ws`):

- Instruction: *"make it chrome and add racing stripes"*
- Composed prompt: `a friendly round robot mascot, glossy white plastic, chrome and add racing stripes`
- New GLB: `8e1e0a46…` (1,683,708 B) — real, distinct
- `lineage`: 2 versions (`Original` → `make it chrome and add racing stripes`), `activeIndex: 1`
- **Data minimization holds**: `grep` of the tool result for `creation_id|job_id|nvidia|prediction` → **false**. No internal identifier, payment field, or coin reference leaks.

### Lineage integrity, revert, and branch (`lineage.json`)

Built through the real `_lineage.js` module:

- `integrity.ok = true`, single root `[0]`, chain length 3.
- **Revert**: `revertTo(lineage, 0)` returns the original GLB — a pointer move over
  immutable history, no mutation.
- **Branch**: appending a child off version 1 (`chrome variant`) yields **two
  leaves `[2, 3]`** — a real tree, not a line.

## B. Remix assets + provenance + royalties (PAID / Claude track only)

Kept entirely OUT of the free OpenAI app.

- **Provenance** lives on the existing `forge_creations` rows (no parallel store):
  `parent_creation_id`, `refine_instruction`, `lineage_index`, `remixable`,
  `remix_royalty_bps`, `creator_wallet_solana`, `remix_settlement_ref`.
- **Browse + publish** (free): `GET /api/remix-feed` lists remixable assets with
  provenance + royalty TERMS visible before remixing (never the raw payout
  wallet); `POST /api/remix-feed {action:'publish'}` opts your own finished model
  in and sets license + royalty + payout wallet.
- **Remix + royalty** (paid): `POST /api/x402/remix-asset` — pay a fixed $0.25
  USDC fee via x402; the platform generates the remix anchored to the source,
  links durable provenance, and routes the creator’s royalty slice on-chain from
  the platform payout wallet (`api/_lib/remix-settlement.js`).

### Split math + caps + payout logic — unit-tested (`tests/remix-settlement.test.js`, 6/6)

- Pays creator their royalty and records provenance (1 USDC @ 10% → 0.1 to
  creator, 0.9 to platform; exact atomics; on-chain send gets the creator amount).
- **Caps a greedy 50% rate to the 20% policy cap** — remixer always keeps the
  majority; value conserved (`creator + platform === fee`).
- Honest no-pay outcomes (never a fake "pending"): `no_creator_wallet`,
  `below_dust_floor` (sub-0.01 USDC), `payout_unconfigured`.
- Split math conservation across many inputs: `tests/remix-royalty.test.js`.

### Live on-chain royalty settlement — post-deploy gate

A real on-chain creator payout requires a **funded platform payout wallet**
(`REMIX_ROYALTY_PAYOUT_KEY`, Base58 64-byte, holding Solana USDC) — not present in
this build environment, so the on-chain leg is a documented post-deploy
verification, exactly like other x402 close-outs in this repo. The transfer reuses
the **already-in-production** `transferSolanaUSDC` rail (the same audited helper the
live vanity-bounty market pays from), and the decision logic around it is unit-
tested above.

**To verify live after deploy** (with a funded payout wallet configured):

```
# 1. Creator publishes a finished model as remixable with a payout wallet:
curl -X POST https://three.ws/api/remix-feed \
  -H 'content-type: application/json' -H 'x-forge-client: <creator-browser-id>' \
  -d '{"action":"publish","creation_id":"<CREATOR_CREATION_ID>",
       "royalty_bps":1000,"creator_wallet":"<CREATOR_SOLANA_ADDRESS>","license":"remix-royalty"}'

# 2. A DIFFERENT agent pays to remix it (x402 client supplies the payment):
#    POST https://three.ws/api/x402/remix-asset
#      { "source_creation_id":"<CREATOR_CREATION_ID>", "instruction":"make it metallic" }
#    → response.royalty.creatorTx is the on-chain settlement signature;
#      response.royalty.creatorUsd / platformUsd show the split; capped=false.
```

The `royalty.creatorTx` in the response is the real settlement reference to paste.

## 2026-07-08 independent re-verification pass

Re-checked this prompt from a fresh chat, ~01:20–01:45 UTC, against the current
`main` and current production, without relying on the evidence above:

- **Code audit:** `refine_model`, `_lineage.js`, `api/forge-iterate.js`,
  `api/_lib/remix-royalty.js`, `api/_lib/remix-settlement.js`,
  `api/x402/remix-asset.js`, `api/remix-feed.js` all read as complete, real
  implementations (no TODOs, no mocks, no stubbed math) — nothing left to build
  for the code itself.
- **Tests:** after restoring a `node_modules` left in a partially-installed
  state by concurrent agents sharing this worktree (missing `zod`/`three`/stale
  nested `rollup` — unrelated to this prompt), the full prompt-09 test set is
  green: `tests/remix-royalty.test.js`, `tests/remix-settlement.test.js`,
  `tests/refine-lineage.test.js`, `tests/forge-iterate.test.js`,
  `tests/mesh-refine.test.js`, `tests/selfie-refine.test.js`,
  `tests/material-studio-lineage.test.js`, `tests/mcp-studio.test.js`,
  `tests/spatial-mcp.test.js`, `tests/mcp-tool-result.test.js` — 154/155 pass;
  the one failure (`restyle_material.readOnlyHint`) is an unrelated annotation
  drift from a different, concurrently-landed feature (material studio), not
  this prompt's surface.
- **Free-surface coin-cleanliness:** `grep -riE
  "royalty|x402|price|usdc|payment|wallet|coin|token" api/_mcp-studio/*.js`
  returns only the module doc-comments that assert the *absence* of a payment
  surface — no royalty/wallet/coin code path exists in the free studio.
- **Live production check:** `GET https://three.ws/api/remix-feed` responds
  immediately (`{"enabled":true,"items":[],"next":null}` — live, but nothing
  has been published to the bazaar yet in prod). `POST /api/mcp-studio`
  (`tools/list`) and `POST /api/forge` both hung 45–90s with zero bytes on
  every attempt — this is the platform-wide P0 `readBody()` hang (see
  `TRACKER.md` top-of-file note), not a defect in this prompt's code: the fix
  landed in commit `ba37182f3` (2026-07-08 01:13 UTC) but the currently-serving
  Cloud Run revision `three-ws-api-00016-pp4` was built at 01:03 UTC, ten
  minutes *before* the fix — the redeploy simply hadn't landed yet at
  verification time. Re-run this same `curl` after the redeploy completes to
  get a fresh, post-fix live GLB proof.
- **Royalty payout wallet — confirmed genuinely unconfigured, not stale
  docs:** `gcloud run services describe three-ws-api --region us-central1`
  lists 112 env vars on the live service; neither `REMIX_ROYALTY_PAYOUT_KEY`
  nor `CLUB_SOLANA_TREASURY_SECRET_KEY_B64` is among them.
- **Why this can't be worked around without owner funding:**
  `api/_lib/solana-transfer.js`'s `transferSolanaUSDC()` (the settlement rail
  this prompt's royalty leg calls) is hardcoded to `network: 'mainnet'` and a
  mainnet-beta RPC by default — real USDC, no devnet variant. Rehearsing the
  actual on-chain payout would mean spending real funds, which no one has
  provisioned. This is a genuine owner-funding blocker (same shape as prompt
  16's devnet-faucet gate and prompt 08's buyer-wallet gate), not a shortcut
  someone skipped.

Net: prompt 09 is code-complete and re-confirmed real by an independent pass.
The only thing separating it from a full live demo is the owner funding a
Solana payout wallet with USDC and setting `REMIX_ROYALTY_PAYOUT_KEY` (or
`CLUB_SOLANA_TREASURY_SECRET_KEY_B64`) in the Cloud Run service env — at that
point the `curl` sequence documented above will produce a real `creatorTx` to
paste here.
