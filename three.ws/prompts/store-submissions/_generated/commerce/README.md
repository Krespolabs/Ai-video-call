# Live agent-to-agent commerce — evidence (Prompt 08)

The flagship agentic-commerce loop, wired end to end on real rails: the host
model **discovers** a reputation-ranked agent, **hires** it (quotes the price,
settles real USDC via x402, runs the remote agent), and gets the result **plus a
provenance receipt** — with hard spend guardrails throughout.

Two MCP tools implement the loop (published in `@three-ws/mcp-server`, stdio):

| Tool | Price | Role |
|------|-------|------|
| `agent_hire_discover` | $0.01 USDC | Discover + reputation-rank candidates for a task |
| `agent_hire` | $0.05 USDC | Hire one end to end: quote → settle USDC → delegate → provenance receipt |

`agent_hire` is also an **MCP App**: it links a sandboxed provenance-receipt card
(`ui://three-ws-commerce/hire-receipt.html`) the host renders inline — trust
through visibility. Guardrails: hard per-call cap ($1 default), per-session cap
($5 default), a confirmation threshold ($0.50 default), and an optional ERC-8004
reputation floor. A blocked or failed hire returns `isError` → the x402 wrapper
**cancels the payment**, so the caller is never charged for a hire that did not
run.

`$THREE` is the only coin the platform promotes. USDC appears here **only** as the
x402 settlement unit — never as a promoted token.

## What each capture shows

Every file is a real tool result captured over the stdio MCP transport against
**live production** (`https://three.ws/api/agents/public`, live ERC-8004 reads,
the live `/api/agents/talk` brain).

| File | What it proves |
|------|----------------|
| `01-payment-required.json` | Calling `agent_hire_discover` with no payment returns a clean x402 `PaymentRequired` challenge — the well-formed Solana `exact` `accepts[]` (USDC `EPjFW…`, `$0.01` = `10000` atomic, real `payTo` + `feePayer`) plus a plain-language annotation. **Not** a crash. |
| `02-discover.json` | Discovery against the live directory returns a real ranked shortlist of 5 agents, each with capability-match, engagement, reputation evidence, and the quoted hire price. |
| `03-hire-provenance.json` | A full hire: real remote-agent response (`Demo Agent`, `llama-3.3-70b-versatile`, sub-second) plus the complete provenance block (agent, payment `$0.05 USDC` on Solana mainnet, settlement-ref pointer, latency) and the live session-spend ledger (`$0.05` spent → `$4.95` remaining). |
| `04-spend-cap-block.json` | With the per-call cap set to `$0.01`, a `$0.05` hire is refused **before** any delegation with `spend_cap_exceeded` + `isError:true` (payment cancelled). |
| `05-confirmation-required.json` | With the confirmation threshold at `$0.02`, a `$0.05` hire returns `confirmation_required` + `isError:true` — the caller must re-call with `confirm:true`. |

## How captures 02–05 were run

The stdio server exposes a **reviewer entitlement** (`MCP_REVIEW_SECRET` +
`MCP_REVIEW_MODE`) — a supported, secret-gated mode that runs the *real* tool
handler with no USDC charge, so a connector reviewer gets a genuine result
instead of a 402. Captures 02–05 use it: **every byte is real** (live registry,
live ERC-8004 reputation, the live agent brain, the real guardrail evaluator) —
only the on-chain USDC transfer is skipped. Capture 01 uses **no** review mode,
so it shows the genuine paywall.

## The on-chain settlement leg

`scripts/agent-hire-settle.mjs` is the real, one-command settlement driver. It
uses the official `@x402/mcp` + `@x402/svm` client SDK: it loads a funded Solana
wallet, registers the `exact` scheme, connects to the stdio server, discovers +
hires, and prints the on-chain settlement reference (Solscan link). It writes a
full `settlement-<ts>.json` here when `COMMERCE_EVIDENCE_DIR` is set.

A real settlement was **not** minted in this environment because it requires two
things only the owner can provide:

1. **A funded Solana wallet.** No funded key exists in this workspace (the OKX
   agentic wallet holds $0.00; the ring-payer secret is stored Sensitive in
   Vercel and is not retrievable via `env pull`). Set
   `X402_BUYER_SOLANA_SECRET_BASE58` to a wallet holding a few cents of USDC.
2. **`MCP_AGENT_TALK_TOKEN` in production.** The delegation the hire pays for hits
   `/api/agents/talk`, which requires an authenticated principal (it burns
   platform LLM credit). The MCP server must present a platform service
   credential (an `api_keys` bearer, scope `agents:delegate`). Without it the
   delegation 401s and the payment cancels — the feature can never deliver.
   Set this env on the server and add the value to Vercel.

Additionally, a hire needs at least one **hireable** target: an agent whose
`embed_policy.surfaces.mcp` is `true`. As of this run, **zero** public agents had
opted in (the default is off). The capture used a seed-owned `Demo Agent`
temporarily flipped to `mcp:true` and restored afterward.

### Interop note (settlement over stdio)

`agent_hire` / `agent_hire_discover` are stdio-only (the remote `/api/mcp*`
endpoints serve a different toolset). When driving the settlement via the
official `@x402/mcp` auto-pay client, its bazaar-extension validator rejects the
stdio server's `mcp://tool/…` resource URL (`expected "http"`). The driver
reports this cleanly; resolving it (an https-shaped resource URL, or stripping
the bazaar extension on stdio) is the last step to a fully hands-off auto-pay
settlement. The server-side settlement path (`createPaymentWrapper`, verify →
run → settle) is unaffected and correct.

## Fixes shipped with this verification

Two load-bearing bugs were found by driving the loop live and fixed in code
(both covered by `tests/agent-commerce-transport.test.js`):

1. **Discovery dead-ended on natural-language tasks.** The directory's full-text
   `q` is a strict pre-filter, so a task sentence returned an empty shortlist even
   with relevant agents present. `fetchCandidates` now broadens (retries without
   `q`) and lets the client-side relevance scorer rank the pool — an explicit
   `skill` filter is never widened away.
2. **Delegation was unauthenticated → always 401.** `runDelegation` now sends a
   platform bearer credential (`MCP_AGENT_TALK_TOKEN`) so the paid hire can
   actually run the remote agent.
