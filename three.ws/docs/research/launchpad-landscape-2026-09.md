# Launchpad landscape, September 2026: where three.ws can improve

Research date: 2026-09-28. Competitors are named by placeholder (Competitor A, B, ...) per the repo convention for research docs; the key and the source list were delivered to the owner in the session that produced this file. pump.fun and Meteora are named because three.ws integrates them as launch rails. Our own numbers come from the production database and the Cloud Run service config, read the same day.

## Bottom line

1. **Our problem is conversion, not reach.** 788 agents were created in the last 30 days and 3 coins were launched. The token plan, built to bridge that gap, has never been saved once.
2. **The two strongest 2026 plays are already built and switched off.** The native Meteora lane prices every agent coin in $THREE on mainnet (the quote-asset pattern that took one new launchpad to about $24M in 30-day revenue within weeks), and the $THREE buyback engine has run 82,208 times since June 19 and skipped every time because `THREE_BUYBACK_ENABLED` is not set.
3. **The native lane needs anti-sniper protection before it goes live.** Its fee schedule is flat. Every serious launchpad ships a fee that starts near 99% and decays over seconds, and a Meteora partner config is fixed once created on-chain, so this has to land first.
4. **Nobody ties agent tokens to real revenue.** On the largest agent launchpad, economic output and token value correlate at roughly zero. We have x402 per-call revenue, custodial agent wallets and 3D embodiment: the stack to close that gap and show it.
5. **Robinhood Chain: fix our screener, don't build a launchpad there.** `/markets/robinhood` indexes two launchpads, one halted in July and one whose domain now redirects elsewhere, and misses the chain's leading launchpad (about $14.3M in 7-day fees).

## Our own numbers

| Funnel stage, last 30 days | Count |
|---|---|
| Avatars created (34,234 Avatar Studio, 9,961 forge; about one per owner, largely guest sessions) | 44,529 |
| Selfie reconstructions | 164 |
| Agents created | 788, by 452 users |
| Coins launched through three.ws | 3 |
| Token plans saved (all time) | 0 |

All-time: 90 mainnet coins from 58 creators since 2026-05-13 (May 26, June 7, July 47, August 7, September 3). The native Meteora lane and the anonymous x402 launch door have 0 launches each.

| Built | State in production | Evidence |
|---|---|---|
| Native Meteora lane, $THREE-quoted on mainnet | Hidden: no `NATIVE_LAUNCH_CONFIG_KEY` | `quoteMintFor()` in `api/_lib/native-launch/config.js` |
| $THREE buyback (`run-three-buyback`, `api/_lib/token/buyback.js`) | Off: `THREE_BUYBACK_ENABLED` unset | 82,208 `skipped / disabled` rows in `three_buyback_runs`; revenue seen 0 |
| Fee Bridge (creator fees to an X handle in USDC, 20% buys $THREE) | Held by owner since 2026-09-17 | `FEE_BRIDGE_ENABLED` unset, page unrouted |
| pump.fun agent-payments (`handlePay` `create`) | Likely broken for new mints | pump.fun stopped new tokenized-agent launches on 2026-07-02 |

## The market in September 2026

**Solana launchpads, 30-day protocol revenue:** pump.fun about $45M (curve plus its AMM), Competitor A about $24M (launched August, coins priced against other assets, about 60% of revenue buys and burns its coin), Competitor B about $7M (a 2025 leader that fell to about 3% share), Meteora DBC about $0.24M protocol cut, and a long tail under $0.2M each. Two 2025 launchpads are effectively dead, one after a class action and its founder's arrest.

**Agent and creator launchpads:** the category peaked near $20B in January 2025 and sits near $4B. What survived is real agent commerce (Competitor J's escrowed agent-to-agent jobs) and perpetual creator royalties (Competitor E). Two agent platforms were sued over promised buybacks and insider allocation. pump.fun shut its agent-revenue buyback mode for fragmenting attention. The closest product to ours (Competitor K: no-code agents with 3D avatars) burns its coin for compute credits with a 10% bonus, and lost trust when deployer-linked wallets sniped about 40% of its launch.

**Fee routing to social handles:** Competitor I launched on 2026-09-15 with the same design as our held Fee Bridge (80% of creator fees to an X handle, 20% buys its coin), paid out about $1.44M in two weeks, and drew backlash for paying people who never opted in.

**Robinhood Chain:** the leading launchpad earned about $14.3M in 7-day fees with an ETH bonding curve, a locked pool and a snipe tax that decays over about five seconds. A major DEX's zero-fee launchpad arrived in August. Chain fees fell about 88% from the September 4 peak, and the wallet gas subsidy ended 2026-09-29. One operator extracted about $18.4M across 53 launches by exempting their own wallets from the snipe tax. No embodied or 3D agent product exists there.

## What the winners have in common

1. A programmatic buyback of the platform coin, shown on a live public counter (50-80% of revenue).
2. The quote asset used as a product lever: pricing launches in an asset turns every buy into demand for it.
3. Fees flowing to holders, not only creators.
4. Anti-sniper protection by default.
5. One opinionated default launch, not a menu.

## Recommendations, ranked

"Owner" marks steps that move funds, sign on mainnet, or change production.

### Tier 1: turn on what is already built

1. **Decaying anti-sniper fee on the native lane, then mainnet.** Exponential fee schedule from about 99% to the 1% base in `api/_lib/native-launch/config.js`, proven on devnet, then the mainnet partner config and `NATIVE_LAUNCH_CONFIG_KEY` (**Owner**).
2. **Turn on the $THREE buyback and publish it.** Live public counter with a link to every buy, fed by `three_buyback_runs`; `THREE_BUYBACK_ENABLED` once the treasury has revenue (**Owner**). Worded as programmatic and non-guaranteed.
3. **Ship the Fee Bridge with consent as the differentiator.** Public claim page per handle, opt-in and opt-out, the agent as a possible recipient (**Owner**: currently held).

### Tier 2: fix the funnel

4. **One default "launch my agent's coin" path.** Auto-draft the token plan from the agent's identity and 3D render, show the free devnet rehearsal, one confirm.
5. **Revenue-backed agents.** Public per-agent P&L (x402 revenue kept apart from trading volume, paying callers, buybacks), a badge only for real paid calls, Daily Match ranked on revenue.
6. **Holder rewards for agent coins,** paid by the agent's wallet, opt-in, framed carefully.
7. **A $THREE compute sink:** pay for credits in $THREE with a bonus.
8. **The agent hosts its own coin live** on Living Stages.
9. **Retire or fix the tokenized-agent path.**

### Tier 3: Robinhood Chain

10. **Fix `/markets/robinhood` coverage** for the launchpads that carry the chain's volume today.
11. **Rug-risk flags on every coin page, both chains:** early-block supply concentration, tax-exempt wallets, the creator's past launches.
12. **Phantom first in the Robinhood Chain buy panel.**

## What not to do

- Don't promise buybacks or revenue to holders.
- Don't add launch modes.
- Don't build a launchpad on Robinhood Chain.
- Don't route fees to people without their consent.
