# DigitalOcean Startups: go/no-go memo

**Decision: NO-GO for now.** No application drafted.
**Verified:** 2026-09-17 against https://www.digitalocean.com/startups and the codebase.
**Revisit trigger:** three.ws ships a self-hostable product that belongs in the DigitalOcean
Marketplace (see "What would make it a fit").

---

## What the program is (from the live page, 2026-09-17)

| Item | Published terms |
|---|---|
| Benefit | 12 months of DigitalOcean credits, "amount varies by partner", generally a "$10,000 monthly limit"; separate GPU credit packages for select startups; Standard-tier paid support free for 15 months; DigitalOcean Marketplace access; partner discounts |
| Eligibility | Raised $10 million or less; company website with a matching company email; a registered DigitalOcean team account on a business email; new to DigitalOcean credits; valid credit card on file; "AI-native startups" prioritised, service businesses ineligible |
| Apply | https://sammydigitalocean.typeform.com/to/tZXAmt (choose "Other" without an accelerator or VC), or https://sammydigitalocean.typeform.com/hatch |

## Does three.ws use DigitalOcean?

**No.** Checked 2026-09-17:

- `git grep -il -E "digitalocean|digital ocean|doctl|DO_API_TOKEN|ondigitalocean"` across the repo
  (excluding `node_modules` and `package-lock.json`) matched only two marketing files that name the
  program: [github-growth-surfaces.md](../github-growth-surfaces.md) and
  [opportunities.csv](../opportunities.csv). No code, config, SDK, or deploy target.
- `package-lock.json` contains no DigitalOcean package.
- Production runs on Google Cloud: one Cloud Run service (`three-ws-api`), Cloud Run GPU model
  services, and Cloud Scheduler, per [docs/ops/gcp-production.md](../../../docs/ops/gcp-production.md).

## Why no-go

1. **No honest usage story.** The program's value to DigitalOcean is a startup building on
   DigitalOcean. Any application would have to describe a migration or a new workload that does not
   exist. We never claim usage that does not exist.
2. **It splits the production stack for no product gain.** Production, the GPU fleet, and the crons
   are on Google Cloud, where the owner has already approved spending the Google for Startups credits
   ([docs/ops/gcp-credits-plan.md](../../../docs/ops/gcp-credits-plan.md)). The workspace rules say to
   prefer GCP and not to onboard new external paid providers without approval. A second cloud adds an
   on-call surface, a second secrets store, and a second billing relationship.
3. **The distribution upside needs a product we do not ship.** The strongest reason to join is the
   DigitalOcean Marketplace. Marketplace listings are deployable apps (1-Click Droplets and similar).
   three.ws is a hosted platform; its self-hostable pieces are not packaged for that.
4. **Card on file and a new team account** are required up front, for a program whose credits we
   would not use.

## What would make it a fit

Reopen this memo if any one of these becomes true:

- A self-hostable three.ws component (for example a packaged 3D generation or rigging worker from
  `workers/`) is published as a container that a DigitalOcean user could deploy, making a Marketplace
  listing a real distribution channel.
- The owner decides to run a real, non-duplicative workload on DigitalOcean GPUs, and approves the new
  provider.

## Owner-only inputs if reopened

Funding raised (must be $10M or less), legal entity, business email owner, and the card for the team
account.

**Pipeline update:** [opportunities.csv](../opportunities.csv) row "DigitalOcean Startups distribution
route" set to `no_go_no_usage`.
