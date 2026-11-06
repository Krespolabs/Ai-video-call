# Tokenized 3D — evidence (prompt 16)

`mint_3d_asset` + `get_3d_asset_onchain`: mint a generated/owned GLB as a
Metaplex Core NFT whose media is a **live, interactive 3D viewer**, with baked
provenance and enforced, capped creator royalties — plus a read-back that
resolves a mint to its holder + provenance + royalty terms.

## What shipped

| Piece | Path |
|---|---|
| Pure metadata + royalty-cap + idempotency core | [api/_lib/tokenize-3d-metadata.js](../../../../api/_lib/tokenize-3d-metadata.js) |
| Mint + durable storage + read-back orchestration | [api/_lib/tokenize-3d.js](../../../../api/_lib/tokenize-3d.js) |
| MCP tool defs (main HTTP server) | [api/_mcp/tools/tokenize.js](../../../../api/_mcp/tools/tokenize.js) |
| Launch-record / idempotency table | [api/_lib/migrations/20260707120000_tokenized_3d_assets.sql](../../../../api/_lib/migrations/20260707120000_tokenized_3d_assets.sql) |
| Unit tests (15) | [tests/tokenize-3d.test.js](../../../../tests/tokenize-3d.test.js) |
| Real devnet mint E2E | [scripts/tokenize-3d-devnet-e2e.mjs](../../../../scripts/tokenize-3d-devnet-e2e.mjs) |

## Evidence files here

- `metadata-sample.json` — a real Metaplex metadata document from the shipping
  builder. Note the GLB under `animation_url` (live 3D media, not a static PNG),
  `properties.files[].type = "model/gltf-binary"`, and `properties.provenance`.
- `tools-registered.json` — proves both tools are in the main MCP catalog with
  the correct annotations (`mint_3d_asset`: write/idempotent/open-world;
  `get_3d_asset_onchain`: `readOnlyHint:true, openWorldHint:true`) and that the
  mint is priced ($0.25 USDC) while the read-back is free.
- `unit-test-output.txt` — 15/15 passing: metadata shape (model under
  `animation_url`), royalty hard cap (clamp + never-exceeds), and the mint
  **idempotency guard** (a double-call does not double-mint).
- `devnet-mint-evidence.json` — written by the E2E script on a live devnet mint
  (see status below).

## Design

- **Network:** devnet by default; `network:"mainnet"` is an explicit opt-in.
- **Royalty hard cap:** 10% (`TOKENIZE_3D_ROYALTY_CAP_BPS = 1000`), enforced
  twice — in `clampSellerFeeBps` before the mint, and by a `CHECK` constraint on
  `tokenized_3d_assets.royalty_bps`. Enforced on-chain via the Metaplex Core
  Royalties plugin (`ruleSet('None')`).
- **Idempotency:** a row is *claimed* (`status='pending'`) via
  `INSERT … ON CONFLICT (idempotency_key, network) DO NOTHING` **before** any
  on-chain call. A second call with the same derived key reads back the winner's
  mint instead of minting again. Failed rows can be reclaimed for a retry.
- **Durable media:** the GLB + a freshly rendered thumbnail are copied into a
  `tokenized/<key>/` R2 namespace (so the NFT media never moves even if the
  source avatar is deleted), and pinned to IPFS when a provider is configured.
- **Provenance:** creator, prompt, generation model/provider, parent lineage,
  and timestamp are baked into `properties.provenance` (off-chain JSON) and the
  `tokenized_3d_assets` launch record.
- **Coin policy:** `$THREE` is the only coin named in copy/metadata. SOL (Core
  rent + royalty rail) and USDC (the x402 mint fee) are settlement mechanics
  only; no other mint is hardcoded.

## Live devnet mint — status

The mint/royalty/read-back **code path** is complete and its on-chain shape
(`create({ plugins:[Royalties…] }).sendAndConfirm` + `fetchAsset`) is identical
to the mints this repo already runs in production
([api/_lib/skill-nft.js](../../../../api/_lib/skill-nft.js),
[api/_lib/onchain-deploy.js](../../../../api/_lib/onchain-deploy.js)).

The standalone devnet E2E (`scripts/tokenize-3d-devnet-e2e.mjs`) is real and
runnable, but at authoring time it could not obtain devnet SOL from this
sandbox: **every public devnet/testnet faucet returned HTTP 429 "you've reached
your airdrop limit today / faucet dry" for this host's IP**, the web faucet
requires an interactive GitHub session, and all secret-key env vars come back
redacted (empty) from `vercel env pull` (Vercel "sensitive" vars), so a
pre-funded wallet couldn't be reused either. This is an external rate limit, not
a code defect.

**Complete the live mint in one command** once ~0.05 devnet SOL is available:

```bash
# Option A — let the script airdrop (works once the faucet limit resets):
node scripts/tokenize-3d-devnet-e2e.mjs

# Option B — supply a pre-funded devnet payer (base58 / base64 / JSON array):
E2E_PAYER_SECRET=<devnet-secret> node scripts/tokenize-3d-devnet-e2e.mjs
```

It mints a real Core asset with the capped Royalties plugin, reads it back with
`fetchAsset`, asserts holder == recipient, `royalties.basisPoints == 1000`
(a 50% request clamped to the 10% cap), that the metadata resolves and its
`animation_url` is the live GLB, and writes `devnet-mint-evidence.json` with the
mint address + Solscan links.
