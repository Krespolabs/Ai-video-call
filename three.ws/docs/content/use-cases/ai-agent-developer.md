# AI-Agent Developer — "Give my agent a body, a wallet, and an interface other agents can call"

> **Every scenario below is an example workflow, not a real customer.** Features and routes are re-confirmed against [`README.md`](../../../README.md).

## Who this is for

You build autonomous agents. You already have an LLM loop and some tools; what you're missing is everything around it — a face users recognize, a way for *other* agents (and MCP hosts) to call your agent, a payment rail so your agent can charge for or pay for work, and a verifiable on-chain identity so its actions can't be spoofed.

## The problem, concretely

A headless agent is a black box. There's no standard way for another agent to discover it, call its tools, or pay it; no portable identity that proves "this action came from this agent"; and no embodiment, so end users can't tell your agent from a chat box. Wiring MCP transport, an agent-to-agent protocol, a USDC payment scheme, and on-chain registration yourself is a quarter of work before you've shipped any agent behavior.

## How three.ws solves it

Four real surfaces give your agent a body, an interface, a wallet, and an identity:

1. **MCP server** — [`@three-ws/mcp-server`](../../../docs/mcp.md) exposes three.ws tools over MCP (JSON-RPC 2.0 over HTTP) so Claude Desktop, Cursor, Claude Code, or any MCP host can drive an avatar and its tools programmatically.
2. **x402 paid endpoints** — [native x402](../../../docs/x402.md) paid endpoints on Base, BSC, and Solana let agents pay each other in USDC for API calls, asset downloads, and skill royalties. Discover and transact via the [bazaar](https://three.ws/x402); **pay-by-name** resolves `@username` / `*.sol` to a recipient so the payer verifies a human-readable name before signing.
3. **A2A — agent-to-agent protocol** — an [A2A client + server, MCP bridge, DID resolution, and spending ledger](../../../README.md#a2a--agent-to-agent-protocol) so agents transact autonomously through delegated signer wallets and EIP-7710 permissions.
4. **On-chain identity** — register the agent as an [ERC-8004 token on any EVM chain or a Metaplex Core asset on Solana](../../../README.md#on-chain-identity-erc-8004--metaplex-core). Each agent gets a stable ID, an owner wallet, a delegated signer, an IPFS-pinned manifest, and a signed action log. SDKs live in [`sdk/`](../../../sdk/) (`@three-ws/sdk`), with EVM payments in `agent-payments-sdk/` and Solana in `solana-agent-sdk/`.

## Example workflow (hypothetical)

> **Imagine a developer, "Vega," who built a market-intelligence agent** and wants it to (a) be callable by other agents, (b) charge for premium queries, and (c) have an identity its callers can trust. Here's the path they'd take.

1. Vega wires the [`@three-ws/mcp-server`](../../../docs/mcp.md) into their MCP host config (`npx -y @three-ws/mcp-server`) so their agent's tools are reachable over MCP.
2. They expose the premium "deep snapshot" query as an [x402 paid endpoint](../../../docs/x402.md): callers hit it, receive a `402` with a price manifest, pay USDC on Base (or Solana), and retry to get the data. The endpoint advertises a `recipient_name` so payers see a readable identity before signing.
3. They register the agent on-chain with the SDK in [`sdk/`](../../../sdk/) — ERC-8004 on an EVM chain or a Metaplex Core asset on Solana — giving it a stable ID, a delegated signer wallet, and a signed action log. Its [on-chain passport](https://three.ws/a/sol/EXAMPLE_ASSET) renders at `/a/[chain]/[id]`.
4. Another agent discovers Vega's service in the [bazaar](https://three.ws/x402), pays via x402, and consumes it over A2A — agents paying agents, settled in USDC, with both identities verifiable on-chain.
5. **Deliverable:** an embodied, MCP-callable agent with a paid endpoint and a forgery-proof on-chain identity — a real economic actor other agents can find, trust, and pay.

## What you get

A standards-based interface (MCP + A2A), a working USDC payment rail (x402 on Base/BSC/Solana with a CDP facilitator on Base mainnet), and an on-chain identity with a signed, auditable action history. The SDKs and contracts are open source. Honest scope note: parts of the on-chain *economy* roadmap (reputation markets, skill royalties) are Phase-3 scaffolding — but MCP, x402 payments, A2A, and on-chain registration are live today.

## Next step / CTA

- Start: [MCP setup](../../../docs/mcp.md) · [x402 docs](../../../docs/x402.md) · [SDK docs](../../../docs/sdk.md) · register via [Register On-Chain](../../../docs/tutorials/register-onchain.md).
- Browse: the [x402 bazaar](https://three.ws/x402) and [MCP Registry listing](https://registry.modelcontextprotocol.io/?q=three.ws).
- **Social spotlight angle (G03):** "Your headless agent → MCP-callable, x402-payable, and on-chain in an afternoon."
- `[REAL CASE STUDY — fill on consent: a developer whose agent earned or paid via x402 in production.]`
