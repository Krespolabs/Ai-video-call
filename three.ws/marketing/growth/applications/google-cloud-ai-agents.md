# Google Cloud: Partner Network, AI Agent Ecosystem Program, Marketplace

**Status:** enrollment answers ready to paste. Marketplace A2A listing **not ready** (two blockers below).
**Verified:** 2026-09-17 (live curl, Cloud Run logs, Google docs). Background, architecture, and the
full business case live in the partner packet
[google-cloud-ai-agents.md](../../partner-packets/google-cloud-ai-agents.md) (verified 2026-09-16);
this file is the field-by-field paste sheet and only restates what changed or what a form needs.
**Deadline:** none published. Pipeline target 2026-09-25.

Nothing here has been submitted. Every submission is an owner action.

---

## Owner-only inputs

| Field | Why only the owner can fill it |
|---|---|
| Legal entity name and state or country of incorporation | Not recorded in the repo. Google requires incorporation "in a supported region" |
| Google account that becomes Partner Administrator | Accepts the Marketplace Vendor Agreement on the company's behalf |
| Payments profile and bank details (Marketplace vendor account) | Financial identity |
| Signatory for the Marketplace Vendor Agreement | Legal acceptance |
| Headcount, revenue, funding stage (if the enrollment or program form asks) | Not recorded in the repo; never estimate |

---

## Blockers re-checked on 2026-09-17

**1. Vertex AI is still billing-denied.** `gcloud logging read` on `three-ws-api` returned
`vertex imagen failed, falling back: Lightning dunning decision is deny for project:
projects/93741856042` at 2026-09-17T03:14:37Z, and two turnaround-view failures with the same
reason seconds later. Google's listing requirements say A2A agents must "Use Google foundation or
3rd party models hosted in Model Garden as a default configuration"
([requirements](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents)). The AI Agent
Ecosystem Program also expects a Gemini or Model Garden model. Clear the billing hold first.

**2. The live Agent Card is not a Marketplace-ready card.** `curl -s
https://three.ws/.well-known/agent-card.json` on 2026-09-17:

| Check | Live value | What the Marketplace copy needs |
|---|---|---|
| `url` | `https://three.ws/` (the website) | The A2A JSON-RPC endpoint. `POST https://three.ws/api/agents/a2a-paid` answers JSON-RPC (a bare `message/send` returned `-32602 Invalid params: message is required`), while `POST /api/a2a` returns 404 |
| `version` | `1.5.1` | Match the platform (`/api/version` reports `1.5.2`, commit `477eb6f8c`, revision `three-ws-api-00438-cg2`) |
| Auth declaration | Older `authentication: { schemes: ["bearer"] }` | A2A `securitySchemes` plus `security` |
| `capabilities.extensions` | One per-call on-chain payment extension with `"required": true` | Remove it or mark it optional: a Marketplace customer is billed by Google, not per call on-chain |
| `description` | Advertises crypto market data and names stablecoin chains | An enterprise description of the 3D skills only |
| Storage | Served from the website | A JSON file in Cloud Storage, in the same project as the listing, attached with **Save and validate** in Producer Portal ([Agent Card doc](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents/agent-card)) |

Google's Agent Card doc recommends the card cover "skills, competence, models, and security". Build a
separate Marketplace card rather than editing the public one, which other clients already read.

---

## Form 1: Google Cloud Partner Network enrollment

**URL:** https://partners.cloud.google.com/enrollment (Google sign-in required, so the exact field
labels could not be read logged out). Google's
[Marketplace requirements](https://docs.cloud.google.com/marketplace/docs/partners/get-started)
state what enrollment must establish: membership "in good standing", incorporation in a supported
region, and a Partner Administrator. The answers below cover every item those docs name, plus the
standard company-profile items.

| Item | Answer |
|---|---|
| Company name | three.ws (legal entity: **OWNER INPUT**) |
| Website | https://three.ws |
| Business contact email | partners@three.ws (the partnership inbox named on `/partners`, per [docs/partners.md](../../../docs/partners.md)) |
| Partner type, if asked | The software or ISV option. three.ws builds a product; it does not resell or deliver services |
| Product description, if asked | three.ws turns a text prompt or photo into a textured, rigged, animation-ready 3D character and embeds it on any page with one web component. Production runs on Google Cloud Run, Cloud Scheduler, and a Cloud Run GPU fleet. |
| Existing Google relationship, if asked | Member of Google Cloud for Web3 Startups (exact wording from [docs/partners.md](../../../docs/partners.md)). Do not write "Google Cloud Partner" anywhere until enrollment is accepted |
| Google Cloud project for the listing | `aerial-vehicle-466722-p5` (production, region `us-central1`) |
| Partner Administrator | **OWNER INPUT** |

**After enrollment:** in Partner Network Hub, **View tasks → Partner tasks → Initiate onboarding
your product to Marketplace**; accept the
[Marketplace Vendor Agreement](https://cloud.google.com/terms/marketplace-vendor-agreement)
(Partner Administrator); complete the **Project Info form** the Marketplace team sends, which grants
Producer Portal access ([vendor steps](https://docs.cloud.google.com/marketplace/docs/partners/offer-products)).

---

## Form 2: Marketplace onboarding "supporting documentation"

Google's vendor doc says this step may require "architecture diagrams or business inputs" and does not
publish field names. Paste from these sources:

| Input | Source |
|---|---|
| Architecture | Packet section "Architecture (for the diagram)": `three-ws-api` Cloud Run service, the Cloud Run GPU services, `three-ws-multiplayer`, Cloud Scheduler, Cloud Build, Vertex AI. Re-read the fleet with `gcloud run services list --region us-central1 --project aerial-vehicle-466722-p5` on the day of submission; the command timed out from this workspace on 2026-09-17, so the packet's 2026-09-16 read is the latest |
| Cloud Scheduler job count | **120** jobs in us-central1 (`gcloud scheduler jobs list`, 2026-09-17), synced from **118** cron definitions in `vercel.json` |
| Product and customer problem | Packet section "Marketplace business case" |
| Hosting pattern | The "AI agents" pattern for the A2A listing type; Google lists it among its approved hosting patterns |
| Production readiness | Google requires "production-ready (not alpha or beta)". Evidence table below |
| Pricing model | **Free** first listing (Google supports Free, Subscription, Usage-based, Combined). Rationale in the packet |

**Production evidence, refreshed 2026-09-17**

| Metric | Value | Source | Captured |
|---|---|---|---|
| Generations recorded / completed (`status = 'done'`) | 40,506 / 34,738 since 2026-06-11 | Production `forge_creations` (read-only query) | 2026-09-17 |
| Generations in the last 30 days | 23,444 (average 756 per day, peak day 1,960) | Same | 2026-09-17 |
| Auto-rig jobs in the last 30 days | 3,929 | Same, `prompt = 'auto-rig'` | 2026-09-17 |
| Avatars / agents / embedded widgets | 75,959 / 3,831 / 632 | `https://three.ws/api/platform/stats` | 2026-09-17T02:58Z |
| Agent Card skills | 10 | `https://three.ws/.well-known/agent-card.json` | 2026-09-17 |
| 90-day uptime | 99.85% overall | `https://three.ws/status` (packet) | 2026-09-16 |

Re-run the counts on the day of submission:

```bash
node --env-file=.env.local --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
console.log(await sql\`select count(*)::int total,
  count(*) filter (where status = 'done')::int done,
  count(*) filter (where created_at > now() - interval '30 days')::int last30
  from forge_creations\`);"
curl -s https://three.ws/api/platform/stats
```

---

## Form 3: Google Cloud AI Agent Ecosystem Program

**Routes** (from Google's program announcement,
[Build, deploy, and promote AI agents](https://cloud.google.com/blog/topics/partners/build-deploy-and-promote-ai-agents-through-the-google-cloud-ai-agent-ecosystem-program),
published 2024-11-20): the application form at
`https://docs.google.com/forms/d/10U-lTYO4J1fgSTjfKWl-EiqjFDnLLqaYvxtLVHSpUf0/viewform`, the partner
representative, or the Marketplace sell page. The form returned **HTTP 401** to an unauthenticated
request on 2026-09-17, and the Partner Network resource page
(`https://partners.cloud.google.com/resources/google-cloud-ai-agent-program`) redirects to Google
sign-in. Field labels are therefore unverified; the answers below cover the program's published
qualification points.

| Published criterion | three.ws answer | Verdict |
|---|---|---|
| Agent addresses a specific goal | Turns a text prompt or image into a textured, rigged 3D character or asset, and validates, inspects, and renders glTF/GLB models for other agents | Meets |
| Uses a Gemini model or a third-party model from Model Garden | Gemini and Imagen lanes exist in code but are billing-denied today (see blocker 1) | **Fails until the billing hold is cleared** |
| Deployed on Google Cloud | Cloud Run service `three-ws-api` in `us-central1`, plus Cloud Run GPU model services | Meets |
| Uses or plans to migrate to Vertex AI services beyond the LLM | Imagen on Vertex for reference images; production 3D reconstruction and rigging already run on Cloud Run GPUs | Meets once Vertex billing is restored |
| Program audience: ISV and services partners | ISV | Meets after Partner Network enrollment |

**Paste-ready answers**

**Company and agent, one sentence:**

> three.ws is a 3D agent platform on Google Cloud whose A2A agent turns text or images into
> textured, rigged, embeddable 3D characters, and validates and inspects glTF models for other agents.

**What does the agent do and for whom?**

> Enterprise product, marketing, and commerce teams want 3D assets and embodied agents but have no 3D
> pipeline. Our agent takes a text prompt or reference image and returns a textured GLB, rigs humanoid
> characters for animation, and returns an embeddable viewer. It also validates glTF/GLB files with
> the Khronos validator and reports mesh, material, and texture statistics with optimization advice,
> so other agents in a multi-agent workflow can check 3D output before using it.

**How is it built on Google Cloud?**

> Production is one Cloud Run service that serves the site, API, and agent endpoints, with Cloud
> Scheduler running 120 jobs and a Cloud Run GPU fleet running the 3D reconstruction, rigging, and
> motion models. Over the last 30 days the platform recorded 23,444 generations. Vertex AI provides
> the Gemini and Imagen lanes.

Send the last sentence only after blocker 1 is cleared, because today every Vertex call falls back.

**What do you want from the program?**

> Technical guidance to make a Model Garden model the agent's default, Gemini Enterprise validation
> of the A2A agent, a Marketplace listing, and placement in the AI agent finder.

**Relationship wording:** member of Google Cloud for Web3 Startups. Not a Google Cloud Partner until
enrollment is accepted. No Marketplace listing exists.

---

## Form 4: Producer Portal (after Project Info form)

Google's seven onboarding steps, each with the answer or the engineering prerequisite:

| Step | Input | Ready? |
|---|---|---|
| 1. Create the AI agent and Agent Card | Marketplace copy of the card, fixes in the table above | **No: engineering** |
| 2. Add the agent in Producer Portal | Listing type "AI Agents as a Service (A2A protocol)" | After step 1 |
| 3. Add the Agent Card | Upload to Cloud Storage in `aerial-vehicle-466722-p5`, **Browse**, **Save and validate** | After step 1 |
| 4. Product details | Name: three.ws 3D Agent. Short description: "Text or image to a textured, rigged, embeddable 3D model, plus glTF validation and inspection for agents." Link: https://three.ws/forge. Screenshot: [forge.png](../../partner-packets/images/forge.png) | Yes |
| 5. Pricing (about 4 business days of review) | Free | Yes |
| 6. Marketplace integration: account creation, Google account linking, sign-in | Not built. `git grep` over `api/`, `server/`, and `src/` on 2026-09-17 found no Cloud Commerce Procurement integration, and `api/auth/` has no Google sign-in provider | **No: engineering** |
| 7. Publish after review | n/a | After 1 to 6 |

## After submitting

Record the Partner Network ID and any program receipt in
[opportunities.csv](../opportunities.csv) row "Google Cloud AI Agents program and finder".
