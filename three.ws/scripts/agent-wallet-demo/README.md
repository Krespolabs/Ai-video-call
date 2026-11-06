# Agent-wallet demo (record-ready)

A scripted agent speaks the **real MCP protocol** to the `@three-ws/avatar-agent`
server — the one published to the official MCP registry as
`io.github.nirholas/3D-AI-Agent-Avatar` — and, from one plain-English goal, gives
a 3D avatar a Solana wallet and pays a brand-new agent a **real, on-chain** amount
of SOL on mainnet. Nothing is mocked.

## Record it

```bash
# 1. Once: grind a vanity www… wallet via the server's wallet_create tool
node scripts/agent-wallet-demo/setup.mjs

# 2. Fund the printed www… address with ~$1 of SOL on mainnet

# 3. Record your terminal while running:
node scripts/agent-wallet-demo/demo.mjs
```

The demo runs these live MCP tool calls in order:
`spawn_avatar` → `wallet_balance` (the agent reads its own funds) →
`wallet_create` (mints a counterparty wallet) → `wallet_send` (real mainnet
transfer, returns a Solscan link) → `wallet_balance` (confirms receipt).

## Knobs

- `SEND_SOL` — amount to send (default `0.001`).
- `PACE` — ms between narration lines for recording cadence (default `650`; set
  `PACE=0` to run flat-out). The real MCP/RPC work is never throttled.
- `SOLANA_RPC_URL` — override the mainnet RPC (a Helius/Triton URL is smoother
  on camera than the public endpoint).

## Notes

- `wallet.local.json` holds the throwaway sender secret and is gitignored. Keep
  the funded balance tiny — it's a demo wallet.
- No screen-recorder is bundled; capture the terminal with OBS / QuickTime, or
  pipe through `asciinema rec` if installed.
