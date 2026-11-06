# Agent x402 payment demo (record-ready)

A captivating ~30-second terminal demo for X: an AI agent calls a **real, live**
three.ws paid service, hits **HTTP 402**, and **pays for it itself in USDC on
Solana** — no card, no human — settled on-chain by the **Coinbase / PayAI x402
facilitator**. Then it prints the paid result and the settlement transaction on
Solscan.

Everything hits production (`https://three.ws`). Nothing is mocked.

## Record it

```bash
# 1. Generate the agent wallet + see the fund address
node scripts/agent-x402-demo/pay.mjs

# 2. Fund that address with a few dollars of USDC on Solana mainnet.
#    PayAI covers the network fee, so the agent needs USDC only — no SOL.

# 3. Record your terminal while running:
node scripts/agent-x402-demo/pay.mjs agent-reputation
```

## Services (the agent buys one)

| arg | what the agent buys |
| --- | --- |
| `agent-reputation` (default) | an on-chain reputation score for another agent |
| `pump-agent-audit` | an audit of a live pump.fun agent's token |
| `symbol-availability` | whether a token ticker is still available |

The price is discovered live from the 402 challenge — the demo never hardcodes it.

## Knobs

- `PACE` — ms between narration lines for recording cadence (default `700`; `PACE=0` runs flat-out).
- `X402_BASE_URL` — override the target (default `https://three.ws`).
- `SOLANA_RPC` — a Helius/Triton URL is smoother than the public endpoint.

`wallet.local.json` holds the throwaway agent secret and is gitignored. Keep its
balance small — it's a demo wallet.
