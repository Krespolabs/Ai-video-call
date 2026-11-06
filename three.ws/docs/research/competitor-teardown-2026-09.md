# Competitor X teardown, September 2026: what three.ws should replicate

Research date: 2026-09-29. Competitor X is a placeholder name for an AI-agent launchpad on Solana. Source: every public page in its sitemap (27 pages, locale duplicates and the 201 per-token pages excluded), its `llms.txt`, the npm registry entries for its four packages, and the GitHub API for its public repos, all read that day. Competitor X's numbers below are self-reported on its own pages and are marked as such. Our side of each comparison was checked against this repo on the same day, with the file that proves it.

Companion to [launchpad-landscape-2026-09.md](launchpad-landscape-2026-09.md), which covers the wider market.

**Status (2026-09-30):** Tier 1 shipped on 2026-09-29. Every remaining item is a work order in `prompts/finish/` (015 to 022 runnable, 919 to 925 owner-gated); start from [the campaign context](../../prompts/finish/_context/parity-00-CONTEXT.md).

## Bottom line

1. **Competitor X's edge is packaging, not technology.** We already ship most of what it sells: a hosted OAuth MCP server with annotated tools, resources and prompts, agent wallets with allowlists and spend caps, automations and autonomous runs, an agent marketplace with full ownership transfer, a token directory, agent email and cards, x402 selling, 90 locales. What it does better is how it presents these: one connector URL, one CLI command, one fee split explained per $100, and pages that show proof.
2. **The biggest cheap wins are in onboarding.** One-click "add to Claude / ChatGPT / Cursor / VS Code" connector links, an `npx three-ws launch` command, and an "official domain and mint" block in `llms.txt`. Each builds on infrastructure that already works in production.
3. **Their developer docs set a writing bar worth matching.** The Partner API reference has one error table with machine codes and `retrySafe` flags, an integration checklist, a support block that asks for `requestId` plus only the key prefix, and a section that openly lists which endpoints are stubs. We should copy that structure and honesty. We should not copy the stubs: our hard rules ban them.
4. **Their own experiment shows the creator-fee flywheel barely fires.** Across 7,215 launches, 0.40% of builders ever earned $500 and 35.6% of tokens never traded once. The launches that worked came from builders who shipped a product first. That matches what our landscape doc found: our problem is agent-to-launch conversion, not reach.
5. **Three things need owner sign-off and are prepared below:** a Solana Foundation `awesome-solana-ai` listing (a PR to an external repo), a public "why three.ws" comparison page (it would name other projects), and a hackathon page (it involves prize money).

## What Competitor X is

An AI-agent launchpad on Solana. Each agent gets its own wallet, a skill set (DeFi, perps, token launch, X posting, market intel), and a pump.fun token whose creator fees the platform collects hourly and splits with the builder. It lists a launchpad partner, a hackathon win and an accelerator as backers. Its agents are built on an open-source agent framework.

| Self-reported metric (2026-09-29) | Value | Where |
|---|---|---|
| Total volume, spot + perps | $212.51M (perps 0.3%) | /analytics |
| Agents funded | 20,046 | /analytics |
| Tokens listed | 20,055 | /tokens |
| SOL redistributed to creators | 12,997 | /stories |
| LLM tokens processed | 3.58B | /analytics |
| Hackathon volume since Aug 18 | $44.65M, 195 tokenized entries | /analytics |

The site contradicts itself, which is a trap for us to avoid rather than a detail to copy. It gives the creator share as 75% (docs, token page, /why-deploy) and 65% (/stories, the experiments post, its awesome-solana-ai listing). It gives the MCP tool count as 132, 126, 121, 109+, 79 and 78 on different pages. And /why-deploy still shows $112M volume and 6,620 agents while /analytics shows $212M and 20,046. Our `check:claude` and `audit:docs` guards exist to stop exactly this kind of drift. Any number we publish on a marketing page should be read live from the API, never typed into the copy.

## Their resource inventory

| Surface | What it does | Why it works |
|---|---|---|
| `/llms.txt` | 40 curated lines grouped as Product / Developers / Learn / Optional, plus an "only official domain, these look-alike sites are not us, official X/Telegram/GitHub, official mint" block | Short enough for an agent to read in full. The anti-phishing block protects users of coin-adjacent products where impersonation is routine. |
| `/mcp` | One connector URL, a deep link that opens Claude's "add custom connector" dialog with the URL pre-filled, tabs per client, and a "Worth knowing" list (you never copy a key, one client at a time, sign in as the account that owns your agents) | Setup is two clicks. The page cites Claude's own help article and asks readers to report drift. |
| `/docs` | A single long page with anchored left nav: 15 built-in and 50 community skills with their tool names, install steps per client, use cases written as ordered tool-call sequences, a 121-tool catalog tagged Read / Write / $Paid, resources, prompts, annotations, API, revenue model, fee split, key tiers, billing | Everything on one page, which is easy to search. Use cases are written as the tool calls an agent would actually make. |
| `/developers` | Versioned Partner API (`/api/v1`) reference: key format and storage (SHA-256 plus 12-char prefix), a 401/403 condition table, tiers, a "read this before you build capacity assumptions" warning that quotas are recorded but not enforced, the `meta.requestId` envelope, the full error table, per-endpoint idempotency notes, an integration checklist, and support instructions | Written for an integrator's first bad day: every failure mode has a code and a next step. |
| `/guide` | 7-step "first agent in 5 minutes": sign in, connect an AI provider (BYOK), fund the billing wallet, create the agent, enable skills, monitor, sell the agent as a paid x402 API | Explains billing wallet versus agent wallet up front, which is the confusion that costs support time. |
| Token page | Token economics: where each $100 of collected fees goes (75 creators, 15 buyback and burn, 5 treasury, 5 ecosystem fund), a live buyback and burn tracker reading a public wallet, the official mint, and a line saying it is not investment advice | People can check the claims on-chain themselves. |
| `/analytics` | Totals, a growth chart, compute tokens per day, and a hackathon leaderboard with its method explained ("volume is estimated from collected fees at the 1% creator rate; 26 entries excluded, off-platform") | Shows how every number was calculated. |
| `/stories/*` | Five case studies, one per category (breakout, creative marketplace, infrastructure, DeFi trader, community operator), each with market cap, SOL earned and links to the mint and the builder's X account | Proof a reader can check, sorted so different kinds of builders each see themselves. |
| `/experiments/*` | Internal experiments written up with method, spend ($0 to $0.28), results and "the parts we got wrong", including one that "ended the project" | Publishing its own failures builds credibility no marketing copy can buy. |
| `/why-deploy` | A flywheel (build, discover, invest), live metrics, a competitor comparison table, a partner list with source links | Direct answer to "why here". |
| Hackathon page | A $350K hackathon: register, post on X, tokenize by a deadline. 15 locales. The token is the entry ticket. | Brings in builders and on-platform token launches at the same time. |
| `/leaderboard` | Top 300 agents by points, with seasons and SOL earned | Keeps people coming back to compete. |
| `/marketplace` | Agents for sale or accepting bids, with a "connect your payout wallet first" warning | Agents become assets people can buy and sell. |
| Local agent page | A local, self-improving CLI and macOS desktop agent installed with one `npx` command | Reaches users who want to run the agent themselves. |
| npm | Four packages: a launch CLI, an agent MCP server, a launchpad MCP server, and the local agent | A separate package for each way people want to use it. |

## Replicate: ranked by leverage over effort

Status comes from a sweep of this repo on 2026-09-29. "Build" is the smallest change that closes the gap.

### Tier 1: small builds on infrastructure that already works

| # | What | Our status | Build |
|---|---|---|---|
| 1 | One-click MCP connect page | Hosted OAuth MCP works (`api/_mcp/auth.js`, `/.well-known/oauth-protected-resource`). We only have copy-paste `claude mcp add` snippets (`src/agent-detail.js`, `src/dashboard-next/pages/api.js`). | A `/connect` page: the connector URL with a copy button, a Claude deep link (`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=three.ws&connectorUrl=<encoded>`), Cursor and VS Code install links, client tabs, and a "Worth knowing" list. Link it from `/mcp-tools`, `/docs` and the dashboard. |
| 2 | Curated `llms.txt` plus an official-links block | `public/llms.txt` is 991 lines, generated by `scripts/build-page-index.mjs` from `data/pages.json`. It has no official-domain or official-mint statement. | In the generator, add an "Official" block at the top (domain, X, Telegram, GitHub, the $THREE mint `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`, "any other domain or mint is not us"). Move the full list to `llms-full.txt` and keep `llms.txt` to roughly 60 curated lines. Show the same block in the site footer and on `/three-token`. |
| 3 | Hosted `/skill.md` | `https://three.ws/skill.md` returns 404. We have `public/skills/` and `skills-index.json`. | Serve a root `skill.md` that explains how an agent uses three.ws (generate 3D, create an agent, launch, pay over x402) and links to the per-skill files. It is the URL skill directories list, and item 11 depends on it. |
| 4 | `npx three-ws launch` and `create` | `npx three-ws login` already runs browser OAuth (`packages/three-ws-cli`, `api/cli/[action].js`). The launch API exists (`api/pump/[action].js`, `api/x402/pump-launch.js`). | Add `create` (an agent with a wallet) and `launch` (name, ticker, image prompts, show the quote, confirm, sign) subcommands. Launch must stop at the quote for an explicit yes, per the spend gate. |
| 5 | Partner API docs, done properly | The v1 envelope and idempotency exist (`api/_lib/agents-v1/http.js`), and keys are hashed with a visible prefix (`api/api-keys.js`). Error tables are scattered across `docs/api-reference.md` and there is no checklist. | One consolidated error table with codes, retry safety and next actions, an integration checklist, a support block (send `requestId`, the endpoint, the UTC time and only the key prefix), and key storage and revocation timing documented. |

### Tier 2: medium builds that turn existing data into proof

| # | What | Our status | Build |
|---|---|---|---|
| 6 | Public per-agent creator earnings | `api/cron/launcher-claimer.js` claims creator fees into agent wallets. The Fee Bridge is held by the owner. There is no public earnings endpoint. | `GET /api/agents/:id/earnings` (lifetime claimed, pending, recent claims with signatures), shown on the agent profile and `/launches/:mint`. This is the number a builder screenshots. |
| 7 | One analytics page | The data is split across `/agent-economy-volume`, `/economy`, `/marketplace/analytics` and `api/home-stats.js`. | `/analytics`: total volume, agents, launches, creator fees claimed, compute tokens per day, x402 settlements, a growth chart, and a "how it's calculated" footnote for every number. |
| 8 | $THREE fee flow "per $100" | `/three-token` has live buybacks with Solscan receipts. There is no per-$100 breakdown or published buyback wallet, and the policy itself is settled in code: the platform never burns $THREE (`SPLIT_POLICIES` in `api/_lib/token/config.js`); the burn in `launcher-claimer.js` is each agent's own coin. Production reported the treasury and rewards wallets as unconfigured on 2026-09-30. | Add a per-$100 diagram for every split policy and the public wallet addresses to `/three-token`, all read from `GET /api/token/config`. |
| 9 | Success stories | None. | `/stories` built from real records: agents with launches, claimed fees, x402 revenue or marketplace sales. Every metric links to its mint or transaction. Only publish agents whose builder opts in. |
| 10 | `/experiments` | Only trading experiments (`/sniper/experiments`, `docs/trading-experiment.md`). | A general index with a fixed template (question, method, spend, result, what we got wrong). Start from the funnel numbers already in the landscape doc: 788 agents and 3 launches in 30 days is exactly the kind of honest finding this format is for. |
| 11 | Agent leaderboard by SOL earned | `/leaderboard` ranks traders and `api/leaderboard/unified.js` ranks creations. There are no points or seasons. | Add an "agents by SOL earned" tab using item 6's data. Points and seasons can follow once the tab gets used. |
| 12 | Whole-agent x402 endpoint | Pricing is per skill (`api/agent-skill-price.js`, `/api/agents/x402/invoke`). | A "sell this agent" switch: set a price per call and get a stable `POST /x402/agents/:slug` that runs one chat turn after payment settles. Solana USDC first. |

### Tier 3: later, or owner-gated

| # | What | Why it waits |
|---|---|---|
| 13 | awesome-solana-ai listing | The Solana Foundation list (426 stars) links Competitor X twice. We are not listed. Proposed entry for "AI Coding Skills > General", once item 3 is live: `[three-ws-skill](https://three.ws/skill.md) - AI agent skill for three.ws: generate textured and rigged 3D models and avatars, create agents with custodial Solana wallets, launch pump.fun coins, and pay or sell services over x402.` It is a PR to an external repo, so it is owner-gated. |
| 14 | "Why three.ws" comparison page | Needs live metrics (item 7) first. It would name other projects, so the content is owner-gated before commit. Competitor X's version is weak where the figures cannot be checked, so every figure on ours must link to its source. |
| 15 | Hackathon page | Competitor X's hackathon produced 195 tokenized entries and $44.65M in volume in six weeks. It involves prize money and judges, so it is an owner decision. The page pattern (register, post, tokenize by a date, live leaderboard of entries) can be reused as is. |
| 16 | API key tiers | We have a flat 120 requests/min on v1 (`api/_lib/rate-limit.js`). Tiers are a pricing decision. If we ship them, enforce them: Competitor X documents that its own quotas are not enforced. |
| 17 | Tweet-to-launch bot | `api/x/*` only posts. Reading mentions and turning them into launches is a new spend path, and each launch would still need the owner's confirmation step. Design it before building. |
| 18 | $THREE deposit bonus | Competitor X gives a 3% credit bonus for deposits in its own coin. Our `api/credits/deposit.js` accepts $THREE with no bonus (holders get up to 30% off spend instead). A deposit bonus is a pricing call. |

## Documentation patterns worth copying

These cost nothing but writing time and apply to our existing docs:

- **Use cases as tool-call sequences.** "Launch a token: `get_launch_status` → `launch_token` → `get_dashboard_urls`." Agents and people both learn the flow faster than from a tool list. Add these to `docs/mcp.md`.
- **"Worth knowing" boxes** on setup pages for the three or four things that surprise people (one client at a time, which account the tools act on, where the credential lives).
- **Cite the vendor's own setup doc and ask readers to report drift.** Honest about the fact that third-party UIs move.
- **Structured 402 bodies with guidance.** Their launch 402 carries `code`, the wallet to fund and the amount needed, so the client can recover by itself. Their post-payment errors carry `retrySafe: true`. Our x402 and launch errors should do the same wherever they are raised after payment.
- **Warn about the redirect that breaks auth.** They document that a cross-host 308 strips the `Authorization` header. Any alternate host we have should be documented the same way.
- **State limits plainly.** "Call limits are recorded but not enforced" is the right tone. We should say the equivalent wherever it is true for us.

## Open resources we can use directly

| Resource | License | Use |
|---|---|---|
| [sendaifun/skills](https://github.com/sendaifun/skills) | Apache-2.0, 130 stars, pushed 2026-07-31 | 44 Solana protocol skills that Competitor X pulls in as its "community skills". We could pull the same repo into our community registry (`community-skills/`, `/skills/community`) through a sync job with a 5-minute cache, instead of writing these by hand. Content naming other protocols goes through the commit gate. |
| [solana-foundation/awesome-solana-ai](https://github.com/solana-foundation/awesome-solana-ai) | README list | Item 13. |

## Do not copy

- **Stub endpoints.** Their v1 ships `/signals/yield` as a static stub, `/indicators` as a fixed payload whatever you ask for, and `/portfolio` as "non-functional, do not integrate". Documenting a stub honestly is better than hiding it, but not shipping it is better still.
- **A platform-owned creator wallet.** Competitor X makes every token's creator its own platform wallet, claims all the fees there, and forwards the builder's share later. Our agent is the creator: it signs the launch and its own fee claims into its own wallet, which its owner can withdraw from (`api/cron/launcher-claimer.js`). Keep it that way.
- **Figures that cannot be checked or have gone stale.** See the contradictions listed above. Every figure on a marketing page should come from a live API.
- **Lifestyle skills with legal exposure** (their cannabis-delivery skill) and **agents that bet by default**. Out of scope for us.
- **Hardcoding other coins into core flows.** Their billing accepts a hackathon sponsor's coin, and fees buy it back. For us that would fall under the commit gate and the "$THREE is the promoted coin" rule.

## What their experiments tell us

From their published founder-allocation experiment (n = 7,215 launches, 2026-02-02 to 2026-07-27):

- 0.40% of builders ever earned $500 in creator fees. The median founder took 0.004 SOL of their own token, and two thirds took none.
- 35.6% of tokens never traded once. On a typical day about two dozen tokens made up the whole live market.
- 0.55% filled their bonding curve, two to three times pump.fun's published rate. It is their best number, and they note it is not the same as becoming a company: three did.

From their swarm experiments: three agents working together did no better than one agent reasoning longer on the same capital, and they stopped the swarm project.

For us: what brings in launches that last is the builder shipping something (their five stories all had a product first), not the fee split. That supports prioritising items 6, 9 and 12 (showing what builders earn, making x402 revenue easy) over matching their revenue-share percentage.
