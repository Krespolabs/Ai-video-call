# Embodied on-chain identity — evidence

Prompt 17: a persona bound to a real Solana wallet + on-chain identity, whose
3D body visually encodes its chain state; tip/send within caps.

Captured by running the REAL `persona_identity` / `persona_tip` / `persona_send`
MCP tool handlers (`api/_mcp3d/tools/persona-identity.js`) against **live Solana
devnet** — no mocks, no fabricated signatures. Regenerate with:

```
node scripts/persona-identity-evidence.mjs
```

Full transcript: [`transcript.json`](./transcript.json).

## What was proven live

| Step | What it proves |
| --- | --- |
| `persona_identity` before funding | A brand-new persona (`persona_AKWOXKofHmWywFabTkAZ`) deterministically derives a real Solana wallet (`BRyentEEF2aFjCzhmxgabJZQdDFiuqNVeT2r6JKtzLwt`) with **zero code path that ever touches its own database or a fabricated balance** — the SOL/USDC balance is read live from `api.devnet.solana.com`, reputation degrades honestly to `unranked`/zero (no attestation DB configured in this environment — a real, designed degrade, not an error), holdings read live via the shared portfolio valuator, and the visual tiers (`unranked` / `none` / `muted: true`) are computed from that real data. |
| Devnet SOL airdrop | A real `requestAirdrop` call to the derived address. In this run the shared devnet faucet returned `Internal error` (`faucet_unavailable`) — devnet faucet flakiness/IP-limiting is a known constraint in this environment (see repo memory `x402-overhaul-campaign` / `gcp-*` notes on prior devnet faucet issues). This is the honest funding blocker, not a fabricated success. |
| `persona_identity` after the funding attempt | Confirms the read is genuinely live (re-queries the same real RPC), not cached — balance stayed 0 because the airdrop did not land. |
| `persona_tip` at $999 | Hard per-call cap ($1 by default) rejects it **before any signature is built**: `{"status":"blocked","code":"over_call_cap"}`. |
| `persona_tip` at $0.50, no `confirm` | Above the $0.25 confirmation threshold and `confirm` omitted: `{"status":"confirmation_required","threshold_usdc":0.25}`. |
| `persona_tip` at $0.05, `confirm:true` | Within every cap, confirmed — reaches REAL on-chain settlement via `submitProtected` (the same MEV-aware execution engine every other outbound transfer on the platform uses). Devnet simulation fails with `AccountNotFound` because the freshly-derived wallet holds no USDC (the source associated token account doesn't exist) — the exact, honest funding blocker the task instructions anticipated: "if you cannot fund a wallet live, finish 100% of the code + tests ... and report the exact funding blocker rather than faking a transfer result." |

## Key-never-leaked proof

The script scans the **entire** captured transcript (every field of every
response, not just the obvious ones) for three private-key shapes:

1. A 64-integer JSON byte array (the raw Solana secret-key encoding).
2. An 87–88 character base58 string (the encoded secret-key length — a Solana
   public key is only 32–44 chars, so this length band is unambiguous).
3. A field literally named `secret` / `secretKey` / `privateKey` / `seed`.

```
OK   — 64-int JSON byte array (raw secret key): no match
OK   — 87-88 char base58 secret-shaped string: no match
OK   — a field literally named secret/secretKey/privateKey: no match

KEY-NEVER-LEAKED: transcript is clean.
```

This is structural, not incidental: `api/_lib/persona-wallet.js` never exports
a function that returns a `Keypair` or seed bytes — `derivePersonaSeed` and
`withPersonaKeypair` are module-private, and `tests/persona-wallet.test.js`
separately asserts they never appear in the module's export list.

## Unit test coverage (fast, deterministic, no network)

- `tests/persona-wallet.test.js` — binding determinism (same id → same
  address, forever), visual-tier pure functions, graceful degradation of the
  full identity read when every upstream is down, and the value-op guardrails
  (bad address / self-payment / over-cap) that never touch the network.
- `tests/persona-spend-ledger.test.js` — per-call cap, cumulative per-session
  cap (including that a *different* session has an independent cap), and
  `defaultSessionId` bucketing.
- `tests/embodiment-chain-visuals.test.js` — every reputation tier and
  holdings tier has a designed mapping (including the empty/unranked/none
  case), muted dims the aura, garbage input never throws.
- `tests/persona-identity-card.test.js` — the identity card builder is pure,
  deterministic, and carries no key-shaped fields.
- `tests/mcp3d-persona-identity.test.js` — tool registration, MCP annotations
  (`persona_identity` read-only; `persona_tip`/`persona_send` destructive —
  pinned alongside `pay_and_call` in `tests/mcp-remote-annotations.test.js`),
  input-schema shape, coin-policy grep, and confirmation that the free/OpenAI
  studio catalog never registers these tools.

Run: `npx vitest run tests/persona-wallet.test.js tests/persona-spend-ledger.test.js tests/embodiment-chain-visuals.test.js tests/persona-identity-card.test.js tests/mcp3d-persona-identity.test.js tests/mcp-remote-annotations.test.js`

## Coin policy

`$THREE` is never referenced by these tools; USDC is the only settlement
asset (mint addresses come from the existing `vault-jupiter.js`
`USDC_MINT_BY_NETWORK` map — no hardcoded third-party mint). Grepped clean in
`tests/mcp3d-persona-identity.test.js`'s `coin policy` describe block.

## Known blocker

Real devnet USDC settlement was not demonstrated end-to-end: the derived
persona wallet has no USDC (a fresh deterministic wallet starts empty by
design), the shared devnet faucet only dispenses SOL and returned an internal
error on this run, and there is no devnet USDC faucet wired into the platform
today. The code path is real and was exercised up to the point of needing
funds — `SIM_FAILED` / `AccountNotFound` from a live `submitProtected`
simulation against devnet, not a mock. Funding the wallet (via a working
devnet SOL faucet + a devnet USDC swap/mint) would complete the last mile.
