# Prompt 19 — Verifiable AI-3D provenance · evidence

Signed, on-chain-anchored content credentials for 3D. Free public verify (both tracks); paid anchor (Claude track).

## Deliverables
| Piece | Path |
|---|---|
| Credential spec (CC0) | `specs/PROVENANCE_3D.md` |
| Pure core (hash / sign / verify / verdict) | `api/_lib/provenance-3d.js` |
| Solana anchor (on-chain write) | `api/_lib/provenance-anchor.js` |
| `verify_provenance` (free) + `anchor_provenance` (paid) MCP tools | `api/_mcp3d/tools/provenance.js`, registered in `api/_mcp3d/catalog.js`, priced in `api/_mcp3d/pricing.js` |
| Free REST verify | `GET /api/provenance?src=<glb>` — `api/provenance.js` |
| Viewer verified/tampered/unverified badge | `public/viewer.html` |
| Docs | `docs/provenance.md` |
| Tests | `tests/provenance-3d.test.js` (20 cases) |

## Verification (run)

- **Hash determinism + tamper sensitivity, sign/verify, verdicts** — `tests/provenance-3d.test.js`, 20/20 green. The `verdicts.json` here shows a real signed credential producing:
  - `verified` (bytes match + signature valid),
  - `tampered` when a single byte changes (`tampered_bytes`),
  - `tampered` when any credential field is altered after signing (`tampered_credential`),
  - `unknown` when no credential is on record.
- **Free verify path is coin-clean** — `verify_provenance` and `GET /api/provenance` responses contain no payment/wallet/token surface (test `the verify response carries no payment/coin/wallet surface`). Live: `GET /api/provenance?hash=<64hex>` → `200 { status: "unknown", … }`; bad hash → `400`.
- **Real signature** — ed25519 over the canonical (key-sorted) credential; `signatureVerifies: true` in `verdicts.json`.

## Blocker (documented, funding-gated)

The live **on-chain anchor** (`anchor_provenance`) needs the issuer key `ATTEST_AGENT_SECRET_KEY` **and** a funded issuer wallet on devnet. Neither is available in this environment, so the credential envelope here carries `anchor.signature: "<devnet-anchor-tx-pending-funds>"`. The anchor code is real (`api/_lib/provenance-anchor.js` writes a signed SPL Memo tx via the existing `sendAndConfirm` rail) and fails closed with a coded error when the key/funds are absent — never a fabricated transaction. Post-funding: run `anchor_provenance` on a real GLB and the returned `anchor.tx` + explorer link complete the devnet verification (`verify_provenance` then returns `verified` with `anchor.confirmed: true`).

## Files here
- `credential-envelope.json` — a real signed credential envelope (the shape stored in R2 at `provenance/<glbSha256>.json`).
- `verdicts.json` — verified / tampered(bytes) / tampered(credential) / unknown, from the pure core.
