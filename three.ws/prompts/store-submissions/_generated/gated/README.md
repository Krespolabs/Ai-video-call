# Evidence — Token-gated 3D embeds (prompt 18)

Generated 2026-07-08. All runs in this folder are real — no mocked network/DB calls
in the `.mjs` demo script; unit tests mock only the HTTP transport layer (`fetch`),
per the repo's existing test conventions (see `tests/holder-pass-pricing.test.js`).

## Files

| File | What it proves |
|---|---|
| `vitest-output.txt` | `npx vitest run tests/embed-gate.test.js --reporter=verbose` — 20/20 passing. Gate pass/fail by balance (`meetsGateThreshold`, `getSplTokenBalance` incl. RPC failover), config normalization, and full access-token sign/verify/expiry/tamper coverage. |
| `live-rpc-fresh-wallet.txt` | A standalone real call to `getSplTokenBalance()` against **live Solana mainnet RPC** for a freshly-generated, never-funded keypair — 185ms round trip, balance `0`, `meetsGateThreshold` correctly `false`. Proves the balance read is genuine, not simulated. |
| `live-e2e-demo-output.txt` | Full run of `scripts/embed-gate-e2e-demo.mjs` — see below. |
| `coin-policy-grep.txt` | The coin-policy grep (command + output) proving no mint other than `$THREE` is hardcoded anywhere in the gating feature. |

## `live-e2e-demo-output.txt` — what it shows, step by step

Run against the real dev Postgres (Neon) and real Solana mainnet RPC, driving the
**actual** `api/embed/gate-verify.js` and `api/embed/resolve.js` request handlers
(not reimplementations) with hand-built Node req/res objects:

1. Creates a disposable owner user + a real public `avatars` row + an unrelated
   second user — all in the real dev DB, all deleted at the end (step 8).
2. `checkAssetOwnership()` — the real owner passes, the unrelated user is refused
   (`not_owner`). This is the exact check `api/embed/gate-create.js` and the
   `create_gated_embed` MCP tool run before persisting a gate.
3. `createEmbedGate()` persists a real `embed_gates` row (mint = `$THREE`,
   `min_amount = 1`), confirmed by reading it back.
4. Generates a fresh ed25519 keypair (`@noble/curves`, the same primitive
   `api/_lib/siws.js` verifies and Phantom/Backpack/Solflare sign with) —
   guaranteed to hold zero of everything, since it has never touched the chain.
5. `POST /api/embed/gate-verify` phase 1 — issues a real one-time nonce, persisted
   in `embed_gate_nonces`.
6. Signs the exact challenge message with the keypair — a **real** ed25519
   signature, not a stub.
7. `POST /api/embed/gate-verify` phase 2 — verifies the real signature (passes),
   burns the nonce, then reads the wallet's balance via **live Solana RPC**
   (~9s — real network latency). Balance is 0 → `{ allowed: false, reason:
   "insufficient balance: hold 1, have 0" }`. This is the **locked/FAIL path,
   proven live end-to-end** through the real handler.
8. `GET /api/embed/resolve` with no `gate_token` → `200 { gated:true, locked:true,
   gate:{...} }` — the real asset's name is returned as a teaser, `glbUrl` is
   never present.
9. Same call with a forged `gate_token` → still locked — resolve.js never trusts
   a client-supplied token that doesn't verify.
10. **Simulating a pass**: mints a real access token via `signEmbedGateToken()`
    (the exact function `gate-verify.js` calls the moment a balance check
    succeeds) for this same gate/asset/wallet, then feeds it into the real
    `resolve.js` handler → `200 { gated:true, unlocked:true, glbUrl: "https://
    pub-....r2.dev/demo/gate-demo-....glb", ... }`. This proves the **unlock
    path** end-to-end through the real handler — the only thing this sandbox
    couldn't produce natively is a wallet that actually holds $THREE (see
    Blocker below); everything downstream of "the balance check passed" is
    exercised for real.
11. A tampered copy of that same token → rejected, still locked (HMAC signature
    check catches the corruption).
12. Cleans up every disposable row.

## Blocker: the live "wallet holds ≥ min_amount → renders" demo

This sandbox has no Solana keypair that actually holds `$THREE` (or any SPL
token), and no way to fund one (no seeded/funded wallet, no faucet for a
real SPL mainnet token). Every other link in the chain — signature verification,
the live RPC balance read itself, nonce lifecycle, access-token mint/verify/
expiry/tamper-rejection, and resolve.js's accept/reject decision — is proven
live above; only the "a genuinely-funded wallet clears the bar" case is
demonstrated via step 10's token-level simulation rather than a live balance
that reads a positive number.

**What would unblock it:** fund any Solana keypair with a small amount of
$THREE (mint `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) — a few dollars'
worth is enough since gates use fractional/uiAmount thresholds — then re-run
`scripts/embed-gate-e2e-demo.mjs` with that keypair's seed. Steps 5–7 would
then show `allowed: true` from a real balance read instead of the simulated
step 10.

## Reproducing

```bash
# Apply the migration once (idempotent):
node scripts/apply-migrations.mjs --apply

# Unit tests:
npx vitest run tests/embed-gate.test.js --reporter=verbose

# Live end-to-end demo (real DB + real Solana RPC; not part of the shipped
# feature — a throwaway evidence script):
node scripts/embed-gate-e2e-demo.mjs

# Coin-policy grep:
grep -rnoE '[1-9A-HJ-NP-Za-km-z]{32,44}' \
  api/_lib/embed-gate.js api/_lib/embed-gate-token.js \
  api/embed/gate-create.js api/embed/gate-verify.js api/embed/resolve.js \
  api/_mcp/tools/embed.js public/embed/v1.js public/embed/v1/gated.html \
  specs/EMBED_SPEC.md docs/token-gated-3d-embeds.md docs/mcp.md \
  api/_lib/migrations/20260708120000_embed_gates.sql \
  tests/embed-gate.test.js STRUCTURE.md data/changelog.json
```
