# three.ws Creator Grant: public terms (PROPOSAL)

**PROPOSAL. Pending owner decision. Not published, not live, no applications accepted.**
The opportunity row "three.ws Creator Grant and CloudCredits listing" is `owner_decision_required`:
the owner either approves these terms (with or without edits) or records a no-go. Nothing below may be
posted, listed, or promised to anyone until then.

**Prepared:** 2026-09-17, from the code and a read-only production query. Figures carry their source and
capture date.

---

## Why a grant, and why it can be honest

Most of what a creator needs on three.ws is already free: text or image to a 3D model on the free
lanes, auto-rigging, and embedding. A "grant" that only repackaged free features would be marketing, not
a benefit, and CloudCredits' contribution guide rejects listings that "function solely as lead
generation without real user value". So the grant must fund things that are **paid today**, and only
those.

## What is free today (verified in code and live)

| Capability | How it is free | Limit | Source |
|---|---|---|---|
| Text or image to 3D on the free lanes | No account, no key. `GET https://three.ws/api/forge?catalog` on 2026-09-17 listed TRELLIS (free), Hunyuan3D / TRELLIS (free), Hunyuan3D, TRELLIS (self-host), and TripoSG as `free: true`, `configured: true` | **240 per hour per IP.** `mcp3dGenerateFree` in `api/_lib/rate-limit.js` uses `FORGE_FREE_HOURLY_SELFHOST` (default 240) when `FORGE_SELFHOST_PRIMARY` is on. Production sets `FORGE_SELFHOST_PRIMARY=1` and has no `FORGE_FREE_HOURLY_SELFHOST` override (`node scripts/read-service-env.mjs`, 2026-09-17), so the live ceiling is 240. `api/forge.js` keys it by client IP | `api/_lib/rate-limit.js`, `api/forge.js` |
| $THREE holder multiplier on that ceiling | A verified tier pass multiplies the free ceiling: Bronze 2x, Silver 3x, Gold 5x, Genesis 10x | Up to 2,400 per hour | `TIERS` in `api/_lib/three-tier.js` |
| Auto-rig an existing GLB | `POST /api/forge?action=rig`; `startRigJob` charges nothing | 30 per hour per IP (`mcp3dGenerate` bucket) | `api/forge.js` |
| Free voices | Edge, Gemini, and NVIDIA TTS lanes, `usdPer1k: 0` | Per-lane limits | `GET https://three.ws/api/tts/catalog` |

## What is paid today (the only things a grant should fund)

Prices from `CATALOG` in `api/_lib/pricing/catalog.js`, evaluated 2026-09-17:

| Action id | What it is | Retail price | Payable from prepaid credits? |
|---|---|---|---|
| `forge.high` | High-quality generation (the "200k poly + PBR" tier) | $0.50 | **Yes.** `api/forge.js` quotes and charges `forge.high` against the credit balance and refunds on failure |
| `forge.gameready` | Game-Ready export for Unity or Unreal | $0.10 | No: settled through `api/_lib/forge-consumption-payment.js`, not the credit ledger |
| `forge.standard` | Standard generation on a paid platform lane | $0.15 | Only matters when the free lanes are unavailable |
| ElevenLabs speech | Premium voice on the platform key | $0.30 per 1,000 characters | Yes (`api/tts/eleven.js`), but **no platform ElevenLabs key exists in production today**, so this lane cannot be offered until one does |

Both `forge.high` and `forge.gameready` are also unlocked by holding $THREE at Bronze or above
(`GATED_FEATURES` in `api/_lib/three-access.js`, `minLevel: 1`).

## Real usage the grant would sit on top of

Read-only query against production `forge_creations`, run 2026-09-17:

| Figure | Value |
|---|---|
| Generations in the last 30 days | **23,444** |
| Auto-rig jobs in the last 30 days | **3,929** |
| All generations since the first row (2026-06-11) | 40,506, of which 34,738 `status = 'done'` |
| Average per day, last 30 days | 756 (peak day 1,960) |

The query that produced them (read-only, loads `DATABASE_URL` from `.env.local`):

```bash
node --env-file=.env.local --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
console.log(await sql\`select
  count(*)::int as total,
  count(*) filter (where status = 'done')::int as done,
  count(*) filter (where created_at > now() - interval '30 days')::int as last30,
  count(*) filter (where prompt = 'auto-rig' and created_at > now() - interval '30 days')::int as rigs30,
  min(created_at) as first
  from forge_creations\`);"
```

`startRigJob` in `api/forge.js` writes every rig job with `prompt: 'auto-rig'`, which is why the rig
count filters on that value.

**Not measured:** the GPU cost of one High generation. Get it before approving a cohort size, from Cloud
Billing reports for project `aerial-vehicle-466722-p5` filtered to the Cloud Run GPU services, divided by
the matching `forge_creations` rows for the same window. Do not publish a "value" figure that implies a
cost basis until that number exists.

---

## Proposed public terms

### What a grantee receives

- **$50 in three.ws prepaid credits**, credited once as a ledger `grant`. At the catalog price that is
  up to **100 High-quality generations** (`forge.high` at $0.50), or the same balance spent on premium
  voice once the platform ElevenLabs lane exists.
- Everything that is already free stays free and unlimited by the grant: free-lane generation (240 per
  hour per IP), auto-rigging (30 per hour per IP), free voices, embedding.
- Credits expire **90 days** after they are granted.

The mechanism exists: `creditAccount({ kind: 'grant', ... })` in `api/_lib/credits.js` writes balance
and ledger in one atomic statement, is idempotent on its key, and is already used this way for referral
welcome credits (`api/_lib/referral-rewards.js`). A grant can never overdraw: debits only apply
`where balance_usd >= amount`.

### Eligibility

- A three.ws account in good standing, older than 7 days, with at least one public creation.
- A public portfolio link showing 3D, game, animation, or web work (any platform).
- One grant per person and per account.
- Must meet the [Terms of Service](https://three.ws/legal/tos) age requirement. Holding $THREE is **not**
  required.

### Capacity

- **Cohort size: 50 grantees per month**, so a full cohort is at most $2,500 of credit at catalog prices
  and at most 5,000 High generations. That is well under one day of current platform volume.
- The shared paid-lane circuit breaker, `FORGE_PAID_GLOBAL_HOURLY` (default 600 per hour, in
  `api/_lib/rate-limit.js`), still applies to every grantee. A grant never lifts a platform ceiling.
- Rolling review; decisions within 7 days; the cohort closes when 50 are granted.

### Abuse controls

| Risk | Control | Exists today? |
|---|---|---|
| Farming grants with many accounts | One grant per account and per portfolio; 7-day account age; manual review | Review is manual. Account age is a DB fact (`users.created_at`) |
| Replayed or double grants | `idempotencyKey` per grantee, e.g. `creator-grant:2026-10:<userId>` | Yes (`credit_ledger` unique key) |
| Draining GPU spend | Grant is a fixed balance; the global paid breaker still caps the lane | Yes |
| Reselling or transferring credits | Credits are account-bound; no transfer path exists | Yes |
| Prohibited content | Existing Terms of Service apply; a violation revokes the unspent balance with an `adjust` entry | Ledger kind `adjust` exists |

### What the owner has to decide

1. **Go or no-go.** If no-go, set the CSV row to `no_go` and record the reason.
2. **Amount and cohort** ($50 and 50 per month proposed; both are single numbers to change).
3. **Expiry.** 90 days is proposed, but the credit ledger has **no expiry mechanism today**. Either
   drop the expiry from the terms or approve building it (a scheduled `adjust` entry for unspent grant
   credit).
4. **Issuing path.** There is no admin grant endpoint or script today. Approve adding a small reviewed
   script that calls `creditAccount({ kind: 'grant' })` for an approved list, so every grant is in git
   history and the ledger.
5. **Who reviews applications,** and where they arrive (proposed: a form on a new `/creator-grant` page
   registered in `data/pages.json`, or `partners@three.ws` for the first cohort).

## After approval: the listing

CloudCredits takes listings as pull requests to https://github.com/t3-sh/cloudcredits.io (its
`CONTRIBUTING.md`: add `src/content/providers/<provider>.yaml`, a logo SVG, and
`src/content/programs/<provider>/<program>.yaml`). Its criteria: "legit and beneficial programs ... from
recognized companies", real value, official links, no lead-generation-only offers. The repository's
last push was 2025-10-20 (GitHub API, 2026-09-17), so a PR may sit unreviewed; the published terms page
is the real deliverable, the listing is a bonus.

Proposed listing values, only after the terms page is live: `value_type: credits`, `currency: USD`,
`min_value: 50`, `max_value: 50`, benefit level 1 ("basic credits ... under $1K"), effort level 1
("complete a simple form"), and `url` pointing at the live terms page.

**Relationship wording:** a CloudCredits listing is a community directory entry, not a partnership.
