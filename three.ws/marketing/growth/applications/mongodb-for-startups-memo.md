# MongoDB for Startups: go/no-go memo

**Decision: NO-GO.** No application drafted.
**Verified:** 2026-09-17 against https://www.mongodb.com/solutions/startups and the codebase.
**Revisit trigger:** a real production workload moves to MongoDB Atlas for a product reason.

---

## What the program is (from the live page, 2026-09-17)

| Item | Published terms |
|---|---|
| Benefit | Atlas credits and support in four tiers (Inspire, Grow, Innovate, Scale) by stage; credit amounts are not published on the page. Promo code has 12 months to activate and 12 months to use |
| Eligibility (base tier) | Less than 7 years old and Series A or earlier; a single software product (no dev shops or agencies); not previously accepted; active company website and LinkedIn profile |
| Product requirement | Must use **MongoDB Atlas** (new and existing Atlas users are eligible) |
| Application fields | Company email, name, company name, company URL, LinkedIn profile, HQ country, funding stage |
| Apply | The form on https://www.mongodb.com/solutions/startups, a VC or accelerator referral, or startups@mongodb.com |

## Does three.ws use MongoDB?

**No.** Checked 2026-09-17:

- `git grep -il -E "mongodb|mongoose"` across the repo (excluding `node_modules`, `package-lock.json`,
  `public/`, `dist/`) matched only: the two marketing files that name this program; the secrets
  scanner `scripts/check-secrets.mjs` (a regex that detects `mongodb://` credentials in diffs); and
  token-list JSON data files that list a tokenized asset named "MongoDB". None is a database
  client.
- `package-lock.json` has **0** `node_modules/mongodb` or `node_modules/mongoose` entries.
- The actual data layer: Neon serverless Postgres through `@neondatabase/serverless`
  ([`api/_lib/db.js`](../../../api/_lib/db.js)), Upstash Redis through `@upstash/redis` for rate limits
  and caches, and an S3-compatible object store client through `@aws-sdk/client-s3`
  ([`api/_lib/r2.js`](../../../api/_lib/r2.js)). The schema is SQL
  ([`api/_lib/schema.sql`](../../../api/_lib/schema.sql)) with migrations in `api/_lib/migrations/`.

## Why no-go

1. **The program requires Atlas usage and we have none.** Applying would mean claiming, or promising,
   a database we do not run. We never claim usage that does not exist.
2. **Migrating to earn credits is backwards.** Production depends on relational features across
   388 SQL migration files (`ls api/_lib/migrations | wc -l`, 2026-09-17) and on Postgres-specific behaviour. Moving any of it to a document
   database to qualify for credits would add risk with no user benefit.
3. **The GTM upside depends on a genuine implementation story**, which is what the pipeline row itself
   asked us to verify first ("Verify production usage ... before applying"). The verification failed.

## What would make it a fit

Only a product-driven reason, for example a new service whose natural store is a document database
(vector search over large, schemaless agent memory) that the owner chooses to build on Atlas. At that
point the application is a four-field form and this memo becomes the draft.

**Pipeline update:** [opportunities.csv](../opportunities.csv) row "MongoDB for Startups GTM route" set
to `no_go_no_usage`.
