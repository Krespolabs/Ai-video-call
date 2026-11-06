# Ring agent buyers

Real platform agents that buy services inside the closed-loop x402 ring — the layer
that makes the ring an **agent-to-agent economy** rather than a cron paying itself
(Task 09). Each persona backs a real `agent_identities` row with a custodial Solana
wallet, and shops the ring in character every tick with its spend limits enforced
and every purchase attributed to it.

See [docs/x402-ring-economy.md → "Agents in the ring"](../../../../docs/x402-ring-economy.md)
for the full narrative; this README is the module map + how to run it.

## What's here

| File | Role |
|---|---|
| `index.js` | Roster provisioning (`ensureRosterAgents`), deterministic persona selection (`selectPersonasForTick`), and the driver `run(ctx)` the autonomous loop invokes as the `agent-buyers` entry. |
| `persona-kit.js` | Shared machinery: seeded RNG (`mulberry32`), float-band math (`planFloatMove`, `floatBand`), and the one guarded settle path every persona uses (`executePurchase`). |
| `endpoint-shopper.js` | Persona — buys market/$THREE intel + health probes. |
| `agora-citizen.js` | Persona — pays club cover + tips dancers after "completing work". |
| `curator.js` | Persona — buys skill-marketplace listings + $THREE billboard slots. |
| `onchain.js` | Low-cadence real on-chain program call (agent-invocation receipt, fee-paid by a ring wallet). |

## Public API

```js
import { run, ensureRosterAgents, selectPersonasForTick, PERSONAS } from './index.js';
import { executePurchase, planFloatMove, mulberry32 } from './persona-kit.js';
```

- `run(ctx)` — one ring-agent tick. `ctx = { origin, conn, blockhash, mintInfo, redis, sql, runId, remainingCap }`.
  Returns the aggregate outcome; it self-records granular per-purchase rows to
  `x402_autonomous_log` with `agent_id`, so the loop adds no summary row (`recorded:true`).
- `ensureRosterAgents(sql)` — idempotently resolve/create the backing agents, provision
  their wallets, stamp spend limits, and register them in `x402_ring_wallets(role='agent')`.
- `selectPersonasForTick(seed)` — deterministic persona selection (pure).
- `executePurchase({ agent, purchase, solana, allowed, persona })` — spend-limit →
  ring-allowlist → pay (agent keypair) → custody-log. Never throws; returns a
  structured, recordable outcome.

## Invariants

- **Buyers are platform-controlled** — custodial keys in `agent_identities.meta`
  (`WALLET_ENCRYPTION_KEY`), registered in `ringAllowedAddresses()`.
- **Every payTo is asserted** against `ringAllowedAddresses()` before broadcast
  (`payX402`'s `onAccept` hook) — a non-ring recipient is refused, not paid.
- **Spend limits enforced** via `enforceSpendLimit` on every purchase — an over-limit
  buy is refused and recorded, never forced through or thrown up the tick.
- **USDC only.** Personas never pay in `$THREE` or any third-party coin. The curator's
  billboard promotes `$THREE` (the platform's own coin) as its subject, never a
  third-party mint.
- **Internal, labeled.** Every log row carries `internal:true` and the persona id —
  personas are never presented as organic users.

## Run it

```bash
# Drive the roster locally for N ticks (default 10) — real end to end; clean skips
# without env/funding. Prints attribution + fund-ledger summaries.
node scripts/x402-ring-agents-run.mjs 10

# Verify the roster wallets are registered + inside the controlled set.
node scripts/x402-ring-verify.mjs
```

## Env

| Var | Default | Meaning |
|---|---|---|
| `X402_RING_AGENT_FLOAT_ATOMIC` | `2000000` ($2) | float target per agent |
| `X402_RING_AGENT_FLOAT_FLOOR_ATOMIC` | target/2 | top-up threshold |
| `X402_RING_AGENT_FLOAT_CEIL_ATOMIC` | target×2 | sweep threshold |
| `X402_RING_AGENT_MAX_BUYS_PER_TICK` | `1` | purchases per persona per tick |
| `X402_RING_AGENT_PERSONAS_PER_TICK` | all | active personas per tick |
| `X402_RING_ONCHAIN_EVERY_N_TICKS` | `60` | on-chain receipt cadence (0 = off) |
| `AGENT_INVOCATION_NETWORK` | `devnet` | cluster for the on-chain receipt |
| `X402_RING_AGENT_OWNER_USER_ID` | (discovered) | owner for auto-created roster agents |
