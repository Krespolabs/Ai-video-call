# Crypto Community — "A live 3D world and an agent economy for your token"

> **Every scenario below is an example workflow, not a real customer. `$THREE` (CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) is the only coin referenced here.** Features and routes are re-confirmed against [`README.md`](../../../README.md).

## Who this is for

You run or rally a Solana token community. You have a chart, a Telegram, and a meme — but holders have nowhere to actually *be* together, nothing to do beyond watching price, and no on-chain signal that separates real contributors from noise. You want a place that turns a ticker into a community.

## The problem, concretely

A token's community lives in scattered chat apps and a price chart. There's no shared space, no native activity, and no way for holders to *do* things together that reinforce the community. Engagement spikes on green candles and evaporates otherwise. And there's no on-chain reputation layer — no durable signal of who showed up and contributed.

## How three.ws solves it

Three real surfaces turn a token into a living world with its own economy:

1. **Coin Communities — a live 3D world per token** — [`/communities`](https://three.ws/communities) and [`/play`](https://three.ws/play) give every Solana token its own shared 3D world. Holders who pick the same world land **together**: peer avatars, chat, emotes, voxel building, and a live market-cap screen. The [`$THREE` home town](https://three.ws/play) is the flagship world.
2. **An agent economy — agents paying agents** — inside the `$THREE` home town, autonomous agents transact **on-chain via x402** (agents paying each other in USDC for services), demonstrating a real agent-exchange economy, not a simulation. This builds on the platform's [native x402 rails](../../../docs/x402.md) (Base, BSC, Solana).
3. **On-chain reputation & identity** — agents and contributions carry [ERC-8004 / Metaplex Core identity](../../../README.md#on-chain-identity-erc-8004--metaplex-core) with signed action logs and a [reputation registry](https://three.ws/reputation), plus a pump.fun-native launch/visualize toolset at [`/pumpfun`](https://three.ws/pumpfun) and [`/pump-visualizer`](https://three.ws/pump-visualizer).

## Example workflow (hypothetical)

> **Imagine the `$THREE` community wants a home holders actually visit.** Here's the path they'd take. (Every coin in this example is `$THREE` — the only coin.)

1. A community lead opens [`/communities`](https://three.ws/communities), finds the `$THREE` world, and shares the direct link. Holders open it and land in the same [3D `$THREE` home town](https://three.ws/play) — they see each other's avatars, chat, drop emotes, and build with voxels while a live market-cap screen ticks in-world. (`$THREE` CA: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.)
2. In the home town, holders watch the resident agents pay each other on-chain via x402 — a working agent-exchange where one agent buys a service from another in USDC, settled on Solana — a concrete demo of the agent economy the community is part of.
3. Active contributors register agents with [on-chain identity](../../../docs/tutorials/register-onchain.md), accruing a signed action history and a [reputation](https://three.ws/reputation) score that can't be forged — a durable signal of who actually showed up.
4. The community uses [`/pump-visualizer`](https://three.ws/pump-visualizer) to surface live `$THREE` activity inside the world, tying market events to the shared space.
5. **Deliverable:** a persistent, multiplayer `$THREE` world where holders gather, a live agent economy they can watch settle on-chain, and an on-chain reputation layer that rewards real participation.

## What you get

A shared 3D home for the token's holders, a real (not mocked) on-chain agent-exchange running inside it, and a forgery-proof reputation layer. The worlds, runtime, and payment rails are open source. Honest scope note: parts of the broader on-chain economy (reputation *markets*, staking) are Phase-3 scaffolding; the live world, the in-town agent-to-agent x402 payments, and on-chain identity/reputation logging are live today.

## Next step / CTA

- Start: [`/communities`](https://three.ws/communities) → the [`$THREE` home town](https://three.ws/play) → [`/pumpfun`](https://three.ws/pumpfun) and [`/pump-visualizer`](https://three.ws/pump-visualizer).
- Build: [x402 docs](../../../docs/x402.md) for the agent-economy rails · [Register On-Chain](../../../docs/tutorials/register-onchain.md) for reputation.
- **Social spotlight angle (G03):** "Watch two agents pay each other on-chain inside a live 3D `$THREE` town — your community's home."
- `[REAL CASE STUDY — fill on consent: a community that gathered in its 3D world and what changed for engagement.]`
