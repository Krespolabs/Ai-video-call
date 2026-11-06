# Solana Foundation grant proposal: sponsor-safe, self-hostable x402 facilitation for Solana

**Status: draft, not submitted. Commit-gated.** This file names crypto projects other than $THREE (the Solana Foundation, USDC, other x402 facilitators and packages), so under the CLAUDE.md commit gate it stays uncommitted until the owner approves the content. Nothing here has been sent to the Solana Foundation.

- Opportunity row: `marketing/growth/opportunities.csv`, "Solana Foundation public-good grant", status `scope_needed`, target date 2026-10-16.
- Program page: https://solana.org/grants-funding
- Application form: https://share.hsforms.com/1GE1hYdApQGaDiCgaiWMXHA5lohw ("Solana Foundation Funding Application")
- Form guidance: https://docs.google.com/document/d/1eK-WNhQmQFyk06XhwWRZJrXn3z_0NDbChZ_Rm8XRoXw
- Evidence gathered: 2026-09-17.

---

## 1. What the Foundation asks for (verified 2026-09-17)

- **Funding types.** Milestone-based grants for public goods, convertible grants for public goods with a commercial component, and Requests for Proposals. This proposal is a **milestone-based public-good grant**.
- **Public good definition.** A project that "either makes a significant open-source contribution to the Solana ecosystem, or if it has a meaningful free community offering."
- **Required.** A project overview, how it delivers public value, "a well structured budget proposal, and include thoughtful milestones", open-sourced learnings, and an answer to "Why Solana?"
- **Milestones.** The guide asks for "measurable milestones for both Product Development and Adoption", each unlocking a stated portion of funding.
- **Process.** Rolling review (about one week), optional due diligence (about three weeks to a decision), then legal finalization. No typical amount is published.
- **Form fields.** Company name, website, country, legal first and last name, email, Solana on-chain accounts, funding amount, funding category, the project, open-source status, amount plus milestones, usage metrics, competition, public good, why you.

---

## 2. Choosing the scope: one package, one gap

### Candidates considered

All are Apache-2.0 and live in this repository. Download counts are npm's own API (`api.npmjs.org/downloads/point/last-month`, window 2026-08-13 to 2026-09-11, fetched 2026-09-17). npm counts include mirrors and CI installs, so they indicate reach, not users.

| Package | What it is | npm last month | Why not chosen (or chosen) |
|---|---|---|---|
| `@three-ws/metaplex-agent-mcp` 0.2.1 | MCP server that registers agents in the Metaplex Agent Registry | 944 | Highest reach, but a wrapper over an existing registry; the grant would fund convenience, not a missing primitive |
| `@three-ws/vanity` 0.1.3 | Solana vanity address grinder | 374 | Well-served category already |
| `@three-ws/skill-license` 0.1.2 | Skill licenses as SPL NFTs plus a PDA | 366 | Narrow audience today |
| `@three-ws/onchain-agent-wallets` 0.1.1 | Agent spending allowance enforced by the SPL Token program | 356 | Strong idea, little production evidence yet |
| `@three-ws/solana-agent` 0.2.2 | Solana agent SDK (keypair, wallet adapter, transfers, x402 exact) | 333 | Broad SDK; hard to scope one verifiable public good |
| **`@three-ws/x402-server` 0.1.3** | **Merchant side of x402: issue the 402, verify, settle, fee split; Solana leads** | **228 (1,559 from first publish 2026-06-24 to 2026-09-16)** | **Chosen: backed by the platform's largest body of production evidence, and the grant closes a verified gap (below)** |

### The gap (verified against code)

1. **Every Solana x402 merchant depends on someone else's facilitator.** `@three-ws/x402-server` settles through a facilitator URL, and its `DEFAULT_FACILITATOR_URL` is a hosted third-party service (`packages/x402-server/src/index.js`). The same is true of most x402 merchant tooling.
2. **three.ws already runs its own Solana facilitator in production, but it is not reusable.** `api/_lib/x402/self-facilitator.js` (951 lines) plus `api/x402-facilitator/[action].js` verify and settle Solana USDC with the platform's own fee payer over its own RPC. It reads platform env vars, the platform connection helper, and a platform payTo allowlist, so nobody else can adopt it.
3. **The reference Solana facilitator does not protect the sponsor's SOL balance.** The upstream `@x402/svm` exact facilitator (x402-foundation/x402, `typescript/packages/mechanisms/svm/src/exact/facilitator/scheme.ts`, read 2026-09-17) validates the transaction shape well: it rejects a fee payer that transfers funds, caps compute-unit price, checks mint, amount, recipient, and memo. It contains no sponsor balance floor, no fee budget over time, and no minimum settle amount. Those are the failures that actually stopped settlement in production here (section 4).

### The scope, in one sentence

**Add a self-hostable, sponsor-safe Solana facilitator to `@three-ws/x402-server`, extracted from the production three.ws facilitator and built on the upstream `@x402/svm` transaction checks, so any Solana merchant can verify and settle x402 payments with their own fee payer and cannot be drained or griefed; contribute the sponsor guards and the attack tests upstream.**

Deliberately out of scope: EVM chains, new token programs, hosted services, dashboards beyond one public metrics endpoint, and anything involving $THREE.

---

## 3. Why Solana

- **Fee-payer sponsorship is native.** A Solana transaction names its fee payer, so the facilitator co-signs as fee payer and the buyer needs no SOL, only USDC. That is what lets an AI agent with nothing but a stablecoin balance pay per call. The same property is the risk this grant fixes: the fee payer signs the whole transaction, so a careless facilitator can be drained (the production code's own security note documents this vector).
- **Per-call pricing survives the fee.** Production sets a minimum sponsor-mode settle of 1,000 atomic USDC ($0.001) because each co-sign burns about 5,000 lamports (`MIN_SPONSOR_SETTLE_ATOMIC` in `self-facilitator.js`). A tenth-of-a-cent API call that still covers its own settlement cost is the economics x402 needs.
- **SPL `TransferChecked` plus Memo** gives a strict, decodable instruction set the facilitator can validate exactly before signing.

---

## 4. Production evidence (how each number was checked)

| Claim | Evidence | Method |
|---|---|---|
| The facilitator is live | `GET https://three.ws/api/x402-facilitator` returns `"service":"three.ws self-hosted x402 facilitator"`, `x402Version: 2`, `exact` on `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, fee payer `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | curl, 200 |
| Lifetime volume (since 2026-07-03) | 136,534 successful settles, 932,590 successful verifications, 2,832.536 USDC moved | read-only query of `x402_self_facilitator_log` |
| Last 30 days | 8,594 successful settles from 3 payer wallets | same table |
| Guards fire in production | 775,408 refused settles; the largest reasons are `fee_runway_exhausted` (fee budget cap) and `fee_wallet_below_floor` (sponsor floor), plus `payer_fee_unfunded` and simulation failures on verify | same table, grouped by `reject_reason` |
| Independent listing | x402scan lists it at https://www.x402scan.com/facilitator/three-ws since `Merit-Systems/x402scan` PR #1032 merged 2026-08-11 | curl 200, `gh pr view` |
| Tested | 71 facilitator test cases across `tests/x402-self-facilitator-{settleable,floor-accounting,fee-meter,min-settle,settle-recovery}.test.js`, `tests/api/x402-facilitator-dispatch.test.js`, `tests/api/x402-facilitator-log-durable.test.js`, `tests/api/healthz-self-facilitator.test.js`; the package's own suite passes 25 of 25 (`node --test`, run 2026-09-17) | test files, local run |
| Package published | `@three-ws/x402-server` versions 0.1.0 (2026-06-24) through 0.1.3 (2026-09-11), zero runtime dependencies | npm registry |

**Honesty note that must stay in any submitted text.** The settlement volume is the platform's own autonomous canary loop (`docs/x402-ring-economy.md`): platform-controlled payer wallets paying platform endpoints, with a single platform payTo, to prove every paid route settles end to end. In the last 30 days no successful settle came from a payer outside the ring wallet table. The numbers prove the facilitator and its guards under sustained load. They are not third-party adoption, and the proposal must not describe them that way. The large refusal count is the guards doing their job under a deliberately tight fee budget, and should be explained, not hidden.

---

## 5. Milestones

T0 is the date the grant agreement is signed. Every deliverable is public and checkable by the Foundation without access to three.ws systems. Each milestone releases the share of funding shown in section 7.

### M1. Standalone facilitator module (development), T0 + 3 weeks

- Move the verify and settle path out of platform code into `packages/x402-server/src/facilitator/`, published as the subpath export `@three-ws/x402-server/facilitator`. The zero-dependency core stays zero-dependency; Solana libraries load only through the subpath.
- Every platform coupling becomes an explicit option: RPC connection or URL list (failover), fee-payer signer, payTo allowlist, log sink.
- Transaction-shape validation delegates to the upstream `@x402/svm` exact facilitator checks wherever they cover the case, instead of duplicating them (open source first); three.ws-specific checks stay only where upstream has no equivalent.
- The production three.ws endpoint switches to the package, so the package is what runs in production from this milestone on.

**Verifiable deliverable:** npm release with the subpath export; `README.md` with a runnable example that stands up a facilitator in one file; the existing 71 facilitator tests ported to the package and passing in `node --test`; `https://three.ws/api/x402-facilitator` still answering, now served by the published version (version string exposed in the response).

### M2. Sponsor guards (development), T0 + 6 weeks

Ship as documented, individually configurable guards, all proven in production today:

- **Sponsor SOL floor:** refuse to settle when the fee payer is below a configured balance (production default 0.02 SOL, `SPONSOR_SOL_FLOOR_LAMPORTS`).
- **Fee budget meter:** cap lamports burned per rolling window (`fee_runway_exhausted` in production).
- **Minimum sponsored settle:** refuse dust transfers that cost the sponsor more in fees than they move (`MIN_SPONSOR_SETTLE_ATOMIC`).
- **Recipient allowlist:** co-sign only transfers to merchant-controlled accounts.
- **Rent-failure detection and bounded ATA-create rent**, so a new recipient token account cannot become an open-ended rent drain.
- **Idempotent settle and settle recovery:** a retried settle never double-broadcasts, and a broadcast whose confirmation was lost is reconciled rather than repeated.
- **Durable decision log interface:** every verify and settle, with a machine-readable refusal reason.

**Verifiable deliverable:** npm release; one test per guard; a `docs/` page in the package explaining each guard, its default, and the failure it prevents.

### M3. Adversarial test suite and upstream contribution (development plus ecosystem), T0 + 9 weeks

- An attack suite of signed-but-malicious Solana transactions run against the facilitator: fee-payer lamport drains, priority-fee inflation, dust griefing, recipient substitution, mint substitution, duplicate submission, lost-confirmation replay.
- The same suite packaged so any x402 Solana facilitator can run it against its own `/verify` and `/settle` endpoints.
- A pull request to `x402-foundation/x402` adding opt-in sponsor-balance and fee-budget hooks (or equivalent the maintainers prefer) plus the attack cases to `@x402/svm`, with an issue opened first to agree the design.

**Verifiable deliverable:** the suite published in the package with a CLI entry that targets any facilitator URL; the upstream issue and PR links, public. Funding for M3 releases on the PR being opened with passing upstream CI and a maintainer review requested. A merge is not required, because the Foundation should not pay on a third party's schedule; the merge outcome is reported in M5.

### M4. Reference deployment and operator guide (adoption), T0 + 12 weeks

- A one-command self-host path: a `Dockerfile` and an example service in the package, deployable to any container host.
- An operator guide: generating and funding a fee payer, choosing floors and budgets, RPC failover, monitoring, and what each refusal reason means.
- A public read-only metrics endpoint on the three.ws deployment reporting settles, verifications, refusals by reason, and sponsor lamports burned, split into internal canary traffic and external payers.
- Registration of the reference deployment in public x402 facilitator directories where one exists.

**Verifiable deliverable:** the Dockerfile and guide in the repository; the metrics endpoint live; a recorded walkthrough of a fresh facilitator settling a mainnet USDC payment in under 15 minutes from `npm install`.

### M5. Adoption report (adoption), T0 + 6 months

**Verifiable deliverable:** a public report with the section 8 metrics against the section 8 baselines, the upstream PR outcome, every issue filed by outside operators and how it was resolved, and security fixes shipped during the maintenance window.

---

## 6. Timeline

| Week | Work |
|---|---|
| T0 to T0+3 | M1 extraction, production cut-over to the package |
| T0+3 to T0+6 | M2 guards and per-guard docs |
| T0+6 to T0+9 | M3 attack suite, upstream issue and PR |
| T0+9 to T0+12 | M4 self-host path, operator guide, metrics endpoint |
| T0+12 to T0+26 | Maintenance, operator support, upstream follow-through, M5 report |

---

## 7. Budget (proposal, every figure owner-adjustable)

**This table is a starting proposal for the owner to adjust, not a quote.** The Foundation publishes no typical grant size, and the guide asks that the amount be "intentional and explained in the milestones section". Engineering is costed at an assumed blended rate of **$5,000 per engineer-week**; the owner should replace that rate with the real one before submitting. The security review figure is an estimate to be replaced with a real vendor quote.

| Line item | Milestone | Basis | Amount (USD) | Rationale |
|---|---|---|---|---|
| Facilitator extraction and production cut-over | M1 | 2 engineer-weeks | 10,000 | Decouple env, RPC, signer, allowlist, and log sink; port 71 tests; switch production to the package |
| Sponsor guards and per-guard docs | M2 | 3 engineer-weeks | 15,000 | Seven guards, each generalized from platform code, tested, and documented |
| Attack suite and upstream contribution | M3 | 2 engineer-weeks | 10,000 | Malicious-transaction corpus, facilitator-agnostic CLI, upstream design discussion and PR iterations |
| Self-host path, operator guide, metrics endpoint | M4 | 2 engineer-weeks | 10,000 | Container path, guide, public metrics split internal versus external |
| Independent security review of the co-signing path | M2 to M3 | external review, estimate | 10,000 | The fee payer signs whole transactions; a second set of eyes on the validation and guards is the difference between "tested" and "safe to recommend" |
| Mainnet conformance funds | M3 to M4 | SOL for sponsor fees and ATA rent, USDC for test payments | 500 | Attack and conformance runs on mainnet, not only devnet; unspent funds reported in M5 |
| Maintenance and operator support | M5 | 2 engineer-weeks spread over 14 weeks | 10,000 | Issue triage, security fixes, upstream review follow-through |
| **Total** | | | **65,500** | |

Proposed release schedule (also adjustable): M1 15%, M2 25%, M3 20%, M4 20%, M5 20%.

---

## 8. Ecosystem impact and success criteria

**Who benefits.** Any Solana developer who wants to charge per request over HTTP 402 without routing settlement through a third party; any existing facilitator operator who wants the sponsor protections and the attack suite; `@x402/svm` users, if the upstream contribution lands.

**Baselines (2026-09-17), then targets.** Targets are goals the grant is measured against, not claims of current adoption.

| Metric | How measured | Baseline | Target by M5 |
|---|---|---|---|
| Independent operators running the facilitator on mainnet | A public `/supported` endpoint or directory listing that identifies the package, confirmed by the operator | 0 | 3 |
| External (non-canary) payers settling through the three.ws reference deployment, 30 days | M4 metrics endpoint | 0 | 25 |
| `@three-ws/x402-server` npm downloads, last month | `api.npmjs.org/downloads/point/last-month` | 228 | 1,000 |
| Public repositories depending on the package | GitHub dependency search for `@three-ws/x402-server` outside `nirholas/*` | owner to record at submission | 5 |
| Attack cases in the suite, all passing on the package | Suite output in CI log | 0 | at least 20 |
| Upstream contribution | `x402-foundation/x402` PR state | none | opened with review requested (M3); outcome reported (M5) |
| Security review findings | Review report | not reviewed | report published, all high and critical findings fixed |

**Learnings shared openly.** The operator guide, the attack corpus, the security review summary, and the M5 report are all public in the repository under Apache-2.0.

---

## 9. Form answers (copy-ready)

| Field | Draft answer |
|---|---|
| Company name | three.ws |
| Website URL | https://github.com/nirholas/three.ws/tree/main/packages/x402-server |
| Country | **OWNER** |
| First Name / Last Name | **OWNER** (legal name; the guide says no pseudonyms) |
| Email Address | **OWNER** |
| Solana On-Chain Accounts | WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW (facilitator fee payer), wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU (facilitator payTo). Both verified from `GET https://three.ws/api/x402-facilitator` on 2026-09-17. |
| Funding Amount | **OWNER** (proposal: $65,500, see section 7) |
| Funding category | **OWNER** to pick from the live dropdown; the closest fit is payments or developer tooling. Not DeFi. |
| Your project / idea | Section 2 "The scope" sentence, then section 2 "The gap" in three short paragraphs. Not referred by a Foundation partner unless the owner says otherwise. |
| Open sourced? | Yes (Apache-2.0) |
| Amount and milestones | Section 5 milestones with the section 7 release percentages expressed in dollars |
| Usage metrics | Section 4 table, including the honesty note, plus the npm numbers in section 2 |
| Competition | Hosted x402 facilitators that support Solana (for example the public PayAI facilitator, whose `/supported` lists Solana mainnet on 2026-09-17) are convenient but put a third party in the settlement path. The upstream `@x402/svm` reference facilitator is self-hostable and validates transaction shape, but has no sponsor balance floor, fee budget, or minimum-settle guard. This package is self-hosted like the reference and adds the sponsor-economics guards and an attack suite from a facilitator that has run on mainnet since July 2026, and it contributes those back upstream rather than competing with the reference. |
| Public good | Apache-2.0 code, zero-dependency core, a facilitator-agnostic attack suite any operator can run, an operator guide, and an upstream contribution to the shared reference implementation. No token, no fee, no account required to use any of it. |
| Why you | Three months of operating a mainnet Solana facilitator under continuous load: 136,534 settles and 932,590 verifications logged, the guards in section 5 written in response to real failures in that log, 71 facilitator tests, an independent listing on x402scan. **OWNER** to add team background and any Solana hackathon history. |

Do not add website links to answers whose question does not ask for one (form instruction).

---

## 10. Re-verification commands (read-only, run the day you submit)

```bash
curl -s https://three.ws/api/x402-facilitator
curl -s https://three.ws/api/x402-facilitator/supported
for p in x402-server metaplex-agent-mcp vanity skill-license onchain-agent-wallets solana-agent; do
  curl -s "https://api.npmjs.org/downloads/point/last-month/@three-ws/$p"; echo
done
(cd packages/x402-server && node --test test/*.test.js)
gh pr view 1032 -R Merit-Systems/x402scan --json state,mergedAt
```

Settlement counts come from `x402_self_facilitator_log` with `DATABASE_URL` from `.env.local` (SELECT only), filtering `ok` by `action`, and excluding payers in `x402_ring_wallets` for the external-payer figure.

## 11. Owner-only inputs before submission

1. Legal first and last name, email, country (the form requires a real name).
2. The real engineering rate and final funding amount, replacing the section 7 assumption; a real security review quote.
3. Funding category selection from the live dropdown.
4. Team background and any Solana hackathon history for "Why you".
5. Whether any Foundation partner or staff referral exists.
6. Approval to commit this file (commit gate: names projects other than $THREE).
7. Agreement that the honesty note on canary-loop volume appears in the submitted text.
