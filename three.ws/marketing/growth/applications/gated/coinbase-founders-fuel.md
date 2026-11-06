# Coinbase Developer Platform Founders Fuel: application package

**Status: draft, not submitted. Commit-gated.** This file names crypto projects other than $THREE (Coinbase, Base, USDC, x402 facilitators), so under the CLAUDE.md commit gate it stays uncommitted until the owner approves the content. Nothing here has been sent to Coinbase.

- Opportunity row: `marketing/growth/opportunities.csv`, "Coinbase CDP Founders Fuel", target date 2026-09-23.
- Campaign row: `marketing/growth/campaigns.csv`, `MKT-2026-10-CDP-X402`, anchor date 2026-10-13.
- Program page: https://www.coinbase.com/developer-platform/discover/launches/founders-fuel
- Application form: https://forms.gle/YDpPXdPQ5sYR5QGy7 ("Founders Fuel Interest Form")
- Evidence gathered: 2026-09-17, against production revision `three-ws-api-00438-cg2` (commit `477eb6f8c`, from `https://three.ws/api/version`).

---

## 1. What the program asks for (verified 2026-09-17)

From the program page:

- **Who it is for.** Builders who "Have a functioning app or working product", "Plan to launch publicly within 3 months", "Are integrating one or more CDP tools (Onramp, CDP Wallet(s), x402, etc.)", and "Show a clear roadmap and intent to ship". Bonus points for onboarded users or early traction.
- **What selected teams receive.** Up to $15,000 in CDP and Paymaster credits; meetings with CDP product leads; a Launch Spotlight ("Social amplification + inclusion in the CDP Builder Showcase"); GTM support (positioning, onboarding UX, partner introductions if aligned); beta access to new developer tools; $5,000 in AWS Activate credits.
- **How to activate.** Apply through the form, share a live product link, submit a launch plan ("just 1 to 2 paragraphs"), and say which credits and tools you want. Review takes 30 to 60 days. A Telegram group is linked for questions.

Consequence for timing: a 2026-09-23 submission may not be decided before the 2026-10-13 campaign anchor. The launch plan below does not depend on acceptance; acceptance amplifies it.

---

## 2. What is actually live (the evidence, with how it was checked)

Present Solana first, truthfully: three.ws is a Solana-native platform, and x402 on Solana runs through its own self-hosted facilitator. The Coinbase Developer Platform and Base lane is an additional, already-wired rail. The application asks Coinbase to help us take that additional rail public, not to replace the home rail.

### 2.1 Solana: the home rail (production proof)

| Claim | Evidence | How verified |
|---|---|---|
| A self-hosted x402 facilitator is live and settles Solana USDC with no third party in the settlement path | `GET https://three.ws/api/x402-facilitator` returns `"service":"three.ws self-hosted x402 facilitator"`, `x402Version: 2`, `scheme: exact`, network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, with `/supported`, `/verify`, `/settle`, `/discovery/resources` | curl, 200 |
| Volume since 2026-07-03 | 136,534 successful settles and 932,590 successful verifications recorded in `x402_self_facilitator_log`; 2,832.536 USDC moved by successful settles | read-only DB query |
| Last 30 days | 8,594 successful settles from 3 distinct payer wallets | read-only DB query |
| Signed receipts | 67,263 rows in `x402_receipts`; buyers retrieve theirs at https://three.ws/receipts ("Receipt Vault") | DB count, page 200 |
| Third-party attribution | x402scan lists the facilitator at https://www.x402scan.com/facilitator/three-ws since `Merit-Systems/x402scan` PR #1032 ("Add three.ws self-hosted Solana facilitator") merged 2026-08-11 | curl 200, `gh pr view` |
| Code | `api/_lib/x402/self-facilitator.js`, `api/x402-facilitator/[action].js`, Apache-2.0 at https://github.com/nirholas/three.ws | repo |

**Honesty note that must stay in any submitted text.** The Solana settlement volume is overwhelmingly the platform's own autonomous canary loop (`docs/x402-ring-economy.md`, `docs/autonomous-x402.md`): platform-controlled payer wallets buying platform endpoints to prove every paid route settles end to end. In the last 30 days no successful settle came from a wallet outside the ring wallet table. It proves the rails work at volume; it is not external customer demand. Do not describe it as customer traction.

### 2.2 Coinbase Developer Platform and Base: the additional rail

| Claim | Evidence | How verified |
|---|---|---|
| Official CDP SDKs are production dependencies | `@coinbase/x402` `^2.1.0` and `@coinbase/cdp-sdk` `^1.50.0` in `package.json`; `createCdpAuthHeaders` from `@coinbase/x402` authenticates facilitator calls in `api/_lib/x402-spec.js`; `generateJwt` from `@coinbase/cdp-sdk/auth` signs Onramp session requests in `api/_lib/coinbase-onramp.js` | code |
| Base settles route through the CDP facilitator whenever CDP credentials are present | `facilitatorFor()` in `api/_lib/x402-spec.js` returns the CDP facilitator for Base and the other CDP EVM networks when `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set | code |
| Those credentials are set in production | `CDP_API_KEY_ID` (literal) and `CDP_API_KEY_SECRET` (Secret Manager reference) are on the `three-ws-api` Cloud Run service | `scripts/read-service-env.mjs --names` |
| Every priced endpoint offers a Base USDC accept beside the Solana ones | `https://three.ws/.well-known/x402.json` lists 4,521 resources; every one carries a Solana USDC accept, and Base (`eip155:8453`) accepts appear 9,041 times across them | curl + parse |
| The 402 challenge carries the Bazaar discovery extension | Live `GET https://three.ws/api/x402/crypto-intel` answers `402` with accepts ordered Solana USDC, Solana $THREE, then Base USDC, and `extensions` = `bazaar`, `eip2612GasSponsoring`, `erc20ApprovalGasSponsoring`, `payment-identifier`, `offer-receipt`; the base64 `PAYMENT-REQUIRED` header mirrors it | curl |
| Real Base mainnet settlements have landed | Two settles on 2026-09-05 (`/api/x402/skill-marketplace`, tx `0xe86b82b06b96e320e60ee1bbbc8fa322b950b41e7241f417f93f5a61955bf4c7`; `/api/x402/solana-register-health`, tx `0xfb98ae4b90ef71929bda91719613546a2a434b3fc0eda9910b8e3835f85d1068`), 0.001 USDC each; the first receipt reads `status 0x1` in Base block 50,888,803 | `x402_audit_log` + Base RPC `eth_getTransactionReceipt` |
| A Bazaar browser consumes the CDP discovery API | https://three.ws/bazaar ("Search and browse the x402 facilitator catalog. Filter by network, price, and extensions. Pay any service in one click.") backed by `api/_lib/x402/bazaar-client.js`, which reads `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` alongside other facilitators; `/api/bazaar/list` currently returns 998 HTTP resources and `/api/bazaar/providers` 1,146 providers | curl, 200 |

### 2.3 The gap we will not hide

On 2026-09-17 a full scan of the CDP Bazaar discovery API (15,733 items, paginated 1,000 at a time) returned **zero** resources on `three.ws`. The Bazaar indexes an endpoint only after its first verify plus settle passes through the CDP facilitator, and drops it after 30 days without a settle (`docs/x402-distribution.md`). Only two real Base settles have landed, and neither is currently listed.

This is exactly the "working product, not yet launched on this rail" position Founders Fuel is built for, and the application should say so plainly rather than claim a Bazaar listing that does not exist.

Closing the gap is already scripted: `scripts/x402-bazaar-settle-sweep.mjs` pays one real Base USDC settle per live endpoint, cheapest first, under a spend cap (default $3), using each endpoint's own runnable `bazaar.input` example. It needs a funded Base buyer wallet (`X402_BUYER_PRIVATE_KEY`), which exists in neither `.env` nor `.env.local` nor the Cloud Run service today. Running it is a spend action and needs the owner's explicit yes (CLAUDE.md gate 1).

---

## 3. Form answers (copy-ready)

Fields marked **OWNER** need facts only the owner has. Everything else is drafted from verified evidence.

| Field | Draft answer |
|---|---|
| Full Name | **OWNER** |
| Email Address | **OWNER** (partnership mail routes to partners@three.ws per `docs/partners.md`; the form likely wants a person) |
| Telegram | **OWNER** |
| LinkedIn | **OWNER** |
| Project or Startup Name | three.ws |
| Location (City, Country) | **OWNER** |
| Team Size | **OWNER** |
| Website or Demo Link | https://three.ws/bazaar |
| GitHub / Code Repository | https://github.com/nirholas/three.ws |
| Which CDP products | x402 (primary) and Onramp. Onramp is real code: `api/onramp/link.js` mints CDP Onramp session tokens through `generateJwt` from `@coinbase/cdp-sdk/auth` (`api/_lib/coinbase-onramp.js`), enabled by the same CDP credentials, and the live endpoint answers `GET https://three.ws/api/onramp/link` with a Solana-address validation error, so it defaults to funding Solana wallets. Do not tick CDP Wallet API or Embedded Wallets: no code for them was found. |
| Describe your product in one sentence | three.ws is a production platform where AI agents create, inspect, and pay for 3D work over x402, with every paid call priced in one discovery catalog and every settlement backed by a signed receipt. |
| What problem are you solving? Who is your target audience? | Agent builders need tools their agents can find and pay for without an account, an API key, or a human in the loop. three.ws turns 3D generation, rigging, model inspection, and agent data into priced HTTP endpoints an agent discovers, pays, and retries in one round trip. The audience is developers building autonomous agents and MCP clients who want creative and 3D capabilities they can buy per call. |
| Is this project live? | Yes, live product |
| How are you planning to use Coinbase Developer tools? | Our x402 rail runs Solana first through our own facilitator; the CDP facilitator is our Base lane. Every priced endpoint already advertises a Base USDC accept, emits the Bazaar discovery extension in its 402 challenge, and routes Base verify and settle through the CDP facilitator with `@coinbase/x402` auth. The next step is getting every endpoint indexed in the Bazaar by settling through CDP, keeping those listings fresh with recurring settles, and publishing a reproducible "agent buys 3D work" builder demo on that lane. |
| What stage is your company or project at? | **OWNER** (choose from Solo builder / Pre-seed / Seed / Post-seed) |
| What would Founders Fuel help you accomplish in the next 30 to 60 days? | Take the Base lane from wired to indexed: every three.ws endpoint listed in the CDP Bazaar with clean metadata, a public builder demo where an agent discovers a 3D capability, receives an HTTP 402, pays, and gets its result plus a receipt, and CDP product-lead feedback on our Bazaar metadata before the 2026-10-13 public session. |
| What kind of support are you most interested in? | Technical support; Co-marketing; Feature prioritization / roadmap feedback. Product credits only if the owner confirms CDP usage will be billed. |
| Open to being featured in Coinbase developer content? | Yes (**OWNER** to confirm) |
| Final notes | Short version of section 2, including the honest Solana-first and ring-volume framing, plus the live links: https://three.ws/bazaar, https://three.ws/receipts, https://three.ws/.well-known/x402.json, https://three.ws/x402/studio. |

### Launch plan (the "1 to 2 paragraphs" the program page asks for)

> three.ws already runs a live x402 economy: 4,521 priced endpoints in a public discovery catalog, a self-hosted Solana facilitator that has recorded more than 136,000 successful settlements since July (largely our own autonomous canary loop proving every route end to end), and signed receipts for every call. Every endpoint also advertises a Base USDC accept routed through the Coinbase Developer Platform facilitator, and two Base mainnet settles have landed. What we have not done is launch that lane publicly: our endpoints are not yet in the CDP Bazaar.
>
> Over the next 90 days we will settle every endpoint through CDP so the Bazaar indexes it, keep those listings fresh with recurring real settles, and publish a reproducible builder demo on 2026-10-13 in which an agent discovers a 3D capability, receives an HTTP 402, pays in USDC on Base, and receives its result and receipt, with an integration guide other agent builders can copy. We will measure settled CDP calls, indexed endpoints, and distinct external buyers, and report them publicly at day 30, 60, and 90. Founders Fuel fits because the remaining work is distribution and feedback, not prototype risk.

Before pasting: re-run the counts in section 5 and replace every number with that day's value (templates.md rule: never paste numbers from an old article).

---

## 4. 90-day launch plan (consistent with MKT-2026-10-CDP-X402)

Campaign row fields this plan honors: anchor proof `https://three.ws/bazaar`; primary channel X; secondary channels Coinbase builder channels, GitHub Discussions, Telegram community, three.ws news; audience CTA "Run one paid call and inspect its receipt"; partner ask "Founders Fuel Launch Spotlight and Builder Showcase review"; primary KPI "settled CDP calls and partner response"; status `awaiting_application`.

Day 0 is the submission date, 2026-09-23. Spend actions are marked **(gate 1)** and need the owner's explicit yes each time; posting to external channels is marked **(gate 2)**.

### Days 0 to 20 (2026-09-23 to 2026-10-13): from wired to indexed

1. Submit the form (owner) and join the program Telegram group for questions.
2. Fund a dedicated Base buyer wallet and set `X402_BUYER_PRIVATE_KEY` locally **(gate 1, owner decides amount)**.
3. `node scripts/x402-bazaar-settle-sweep.mjs --dry-run`, review the endpoint list and spend, then run it under `--max-usd=3` **(gate 1)**. All Base accepts pay the owner's wallet, so the spend is an internal transfer plus facilitator-paid gas.
4. Verify indexing with the CDP discovery API scan in section 5 (not the `EXTENSION-RESPONSES` header, which upstream issue x402-foundation/x402#2112 documents as sometimes missing).
5. Fix any endpoint the Bazaar rejects (most likely cause: a `bazaar.input` example that does not validate against its `inputSchema`, or zero-amount auth-hint accepts; see "Known listing blockers" in `docs/x402-distribution.md`).
6. Record the builder demo: an agent calls `/api/x402/crypto-intel` or a 3D endpoint, receives the 402, pays on Base through CDP, gets the 200 plus `X-PAYMENT-RESPONSE`, and the receipt is visible at `/receipts`. Record the Solana path in the same session so the home rail leads the piece.

### Day 20 (2026-10-13): public anchor

7. Publish the campaign piece "An AI agent discovers and purchases 3D work over HTTP 402" on X, with the Solana path shown first and the CDP Base lane shown as the second rail **(gate 2)**.
8. Cross-post to GitHub Discussions, the Telegram community, and three.ws news **(gate 2)**; add a `data/changelog.json` entry if the Base lane indexing is a user-visible change.
9. Share the demo and integration guide in Coinbase builder channels; if accepted by then, request the Launch Spotlight and Builder Showcase review **(gate 2)**.

### Days 20 to 60 (to 2026-11-22): keep listings alive and earn ranking

10. Keep every indexed endpoint inside the Bazaar's 30-day window with at least one real CDP settle per endpoint per 30 days. The Solana ring payer (`api/_lib/x402/pay.js`) is Solana-only, so this is a recurring run of the sweep script **(gate 1, owner sets the monthly cap)** until a Base leg is added to the autonomous loop.
11. Publish the integration guide as a docs page under `docs/` (the Base lane section of `docs/x402-buyer.md` or a new tutorial), with a runnable example.
12. Day 30 public metrics post **(gate 2)**. If accepted, use the CDP product-lead session for Bazaar metadata and ranking feedback.

### Days 60 to 90 (to 2026-12-22): conversion and report

13. Target outreach to agent and MCP builders who already buy on the Bazaar, with the one-paid-call CTA.
14. Day 60 and day 90 metrics posts **(gate 2)**, reporting the same KPIs, with external buyers separated from internal sweep and ring payers.
15. Update `marketing/growth/campaigns.csv` status and the opportunity tracker with the application ID, decision, and any Builder Showcase or social URL.

### KPIs and how each is measured

| KPI | Source | Day 0 baseline (2026-09-17) |
|---|---|---|
| three.ws resources indexed in the CDP Bazaar | Full scan of `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | 0 of 15,733 |
| Settled CDP calls (Base) | `x402_audit_log` rows `event_type='payment_settled'`, `network='eip155:8453'`, excluding the two `/api/x402/replay-test` fixture rows | 2 |
| Distinct external Base buyers | Same rows, payer not the sweep buyer wallet | 0 |
| Solana settles, 30 days (home rail, reported first) | `x402_self_facilitator_log` `action='settle' and ok` | 8,594 from 3 payers |
| Partner response | Form decision, Launch Spotlight or Builder Showcase URL | none |

---

## 5. Re-verification commands (read-only, run the day you submit)

```bash
# Production revision
curl -s https://three.ws/api/version

# Facilitator and catalog
curl -s https://three.ws/api/x402-facilitator
curl -s https://three.ws/.well-known/x402.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).resources;const base=r.filter(x=>x.accepts.some(a=>a.network==='eip155:8453')).length;console.log({resources:r.length,withBaseAccept:base})})"

# Live 402 challenge: accepts order and extensions
curl -s https://three.ws/api/x402/crypto-intel | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.accepts.map(a=>a.network),Object.keys(j.extensions||{}))})"

# CDP Bazaar presence (full paginated scan)
for off in $(seq 0 1000 16000); do curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000&offset=$off"; echo; done | grep -o '"resource":"https://three.ws[^"]*"' | sort -u | wc -l
```

Database counts come from `x402_self_facilitator_log`, `x402_audit_log`, and `x402_receipts` with `DATABASE_URL` from `.env.local` (SELECT only).

---

## 6. Wording rules for anything sent

- Solana leads every paragraph that mentions chains. Base is "an additional rail", never "our chain".
- Never call ring or sweep settles "customers" or "traction". Say "autonomous canary loop" or "internal settles".
- Never claim a Bazaar listing until the section 5 scan returns a non-zero count that day.
- Partner statuses, exactly as `docs/partners.md` states them: "OpenAI Select Partner"; "IBM Business Partner" (with the rule that the public `/api/ibm/*` tools are not IBM partnership deliverables); "member of NVIDIA Inception"; "member of Google Cloud for Web3 Startups"; "AWS Partner, and the Marketplace listing is coming"; "member of the Quicknode Startup Program". No endorsement is claimed by any of them.
- Do not pitch $THREE price. $THREE may appear only as the second Solana accept that is factually in the challenge.

## 7. Owner-only inputs before submission

1. Personal fields: name, email, Telegram, LinkedIn, location, team size, company stage.
2. Approval to commit this file (commit gate: names projects other than $THREE).
3. Whether to fund a Base buyer wallet, how much, and the monthly settle cap for keeping listings alive (gate 1).
4. Confirmation that Onramp is a lane the owner wants to present (it is wired and credentialed, but no end-to-end purchase was run for this draft).
5. Approval of every external post in section 4 (gate 2), and consent to be featured in Coinbase developer content.
