# ElevenLabs Startup Grants: final application sheet

**Status:** ready to submit **if** the owner confirms headcount under 25 and accepts the minors-policy
disclosure below.
**Verified:** 2026-09-17 against https://elevenlabs.io/startup-grants, the live `/voice` page,
`/api/tts/catalog`, the Cloud Run service env, and the code. Background and the first draft are in
the packet [elevenlabs-startup-grants.md](../../partner-packets/elevenlabs-startup-grants.md)
(2026-09-16). This sheet supersedes the packet's answer text where the two differ.
**Apply at:** https://elevenlabs.io/grants-application (terms checkbox, then the questions).
**Deadline:** rolling; "applications are considered on a rolling basis", decisions "within one week".
Pipeline target 2026-09-24.

Nothing has been submitted.

---

## Owner-only inputs

| Field | Note |
|---|---|
| Employee count | Must be under 25 "at the time of application". Not recorded anywhere in the repo |
| Applicant name, role, business email | Use a three.ws address; personal email is disqualifying ("Only applications with valid business emails will be considered") |
| Team description and founder bio | Not in the repo |
| Legal entity and country | Terms exclude sanctioned jurisdictions |
| Acceptance of the grant terms | Ticking the box accepts terms for the company, including ElevenLabs' licence to use the three.ws name and logo |
| Prior ElevenLabs enterprise contract or prior grant | Neither is recorded in the repo; owner confirms |

---

## Eligibility check against the public criteria (2026-09-17)

The grant provides 12 months of access, "33,000,000 characters" (about 680 hours of agent usage),
stated as "$5,500+ in value", plus founder community access. Characters cannot be exchanged or resold.

| ElevenLabs criterion (quoted) | Evidence | Verdict |
|---|---|---|
| "Monetized product use case" | The ElevenLabs lane is priced in code: `/api/tts/catalog` returns `billing: "credits"`, `usdPer1k: 0.3`; the `/voice` page reads "$0.50 per voice clone, $0.30 per 1,000 spoken characters". Platform-key clones charge the user's prepaid credit balance (`api/tts/eleven-clone.js`) | Meets |
| "No short-term or one-off projects" | Generations recorded since 2026-06-11; public changelog | Meets |
| Valid business email | three.ws domain | Meets (owner uses it) |
| "startups or companies with less than 25 employees" | Not recorded | **Owner confirms** |
| "No agencies or consulting firms" | Product company | Meets |
| "Each company can only submit one application" | No prior application recorded | Meets as far as the repo shows |
| Existing enterprise customers ineligible | No contract recorded | Meets as far as the repo shows |
| "No projects for minors" | The platform is not built for children, but the live [Terms of Service](https://three.ws/legal/tos) say "You must be at least 13 years old to use the Service" | **Disclosure risk.** Do not describe the audience as adults-only. If asked, state the 13+ general policy honestly. The owner may choose to restrict the ElevenLabs voice features to 18+ before applying; that is a product decision, not a wording fix |

**Go/no-go:** go, conditional on the headcount and the owner's call on the minors row.

---

## Live integration proof (verified 2026-09-17)

| Claim | Evidence |
|---|---|
| `/voice` is live | `curl -o /dev/null -w "%{http_code}" https://three.ws/voice` returned `200` |
| Shared ElevenLabs client exists | [`api/_lib/elevenlabs.js`](../../../api/_lib/elevenlabs.js), 219 lines: base URL `https://api.elevenlabs.io/v1`, default model `eleven_flash_v2_5`, `listVoices`, `createClonedVoice`, `deleteVoice`, per-request key resolution |
| Models offered | `eleven_flash_v2_5`, `eleven_turbo_v2_5`, `eleven_multilingual_v2` (catalog and `TTS_MODELS`) |
| Endpoints | `api/tts/eleven.js` (synthesis), `api/tts/eleven-clone.js` (instant cloning), `api/tts/eleven/voices.js`, `api/tts/eleven/library.js`, `api/agents/_id/voice.js` (per-agent voice) |
| Lip-sync | Viseme analysis in `src/lip-sync-analyser.js`, imported by `src/agent-avatar.js`; the `<agent-3d>` element drives viseme morphs (`src/element.js`) |
| **Lane state today** | `/api/tts/catalog`: ElevenLabs `available: false`, `byok: true`, `clone: true`, reason "Add your own ElevenLabs key below" |
| **Platform key** | `node scripts/read-service-env.mjs '^ELEVENLABS' --names` returned "no variable on three-ws-api matches". There is no platform ElevenLabs key in production |

The honest pitch is therefore: the integration is complete and metered, it runs today only on a user's
own key, and the grant switches on the platform lane for every visitor.

---

## Application answers (paste as written)

**Company one-liner**

> three.ws turns a text prompt or photo into a rigged 3D AI agent that speaks, gestures, and reacts on
> any web page.

**What are you building?**

> three.ws is an open-source platform for embodied AI agents. A user describes a character, gets a
> textured and rigged 3D avatar, gives it a mind and a voice, and embeds it on any site with one web
> component. ElevenLabs is integrated into that flow: speech synthesis, instant voice cloning, the
> Voice Library, and per-agent voices, with Flash v2.5 as the default for low latency and Turbo v2.5
> and Multilingual v2 selectable. The avatar's mouth follows the audio through viseme lip-sync, so the
> voice becomes a face and body rather than an audio track beside a character.

**How do you use (or plan to use) ElevenLabs?**

> The integration is finished in production code and runs today on a bring-your-own-key basis: a user
> adds their ElevenLabs key and synthesis and cloning bill their own account. We do not yet have a
> platform ElevenLabs account, so visitors without a key hear our free voices instead. The grant would
> switch on the platform lane so any visitor can give a 3D agent an ElevenLabs voice. We would use it
> for default voices on public demo agents, voice cloning for creators, and a public browser demo in
> which a cloned voice drives a rigged avatar in real time.

**How do you make money / business model?**

> ElevenLabs usage on the platform lane is already priced: $0.30 per 1,000 characters and $0.50 per
> voice clone, charged to a prepaid credit balance, alongside paid high-quality 3D generation and
> exports. Across the platform, 75,959 avatars and 3,831 agents exist and 632 widgets are embedded on
> other sites. Every embedded agent that speaks with a premium voice is repeat, metered usage.

**How do you expect to grow?**

> Embeds and creators. The platform recorded 23,444 3D generations in the last 30 days. Each generated
> character is a candidate for a voice, and each embed puts that voice on a site we do not own. Our
> first milestone with the grant is making an ElevenLabs voice the default choice for newly created
> public agents, measured by characters synthesized per week on the platform lane.

**Team:** **OWNER INPUT** (names, roles, headcount).

**Anything else**

> We would welcome consideration for a future Startup Grants Demo Day with the step from a voice
> agent to a visible digital human.

Do not promise Demo Day 2026: https://demoday.elevenlabs.io/ lists the "Startup Grants Virtual Demo
Day" on Wednesday, October 21st 2026, 6:00 PM (CEST), and a grant awarded now is unlikely to be in it.

---

## Figures used and how to refresh them

| Figure | Value | Source | Captured |
|---|---|---|---|
| Avatars / agents / widgets | 75,959 / 3,831 / 632 | `curl -s https://three.ws/api/platform/stats` | 2026-09-17T02:58Z |
| Generations, last 30 days | 23,444 | Production `forge_creations` (see the query in [google-cloud-ai-agents.md](./google-cloud-ai-agents.md)) | 2026-09-17 |
| ElevenLabs pricing | $0.30 per 1,000 characters, $0.50 per clone | `/api/tts/catalog` and the `/voice` page | 2026-09-17 |
| ElevenLabs characters synthesized | **Not measured.** BYOK calls bill the user's own ElevenLabs account and no platform key exists | n/a | n/a |

**Relationship wording:** there is no relationship with ElevenLabs. Say "three.ws integrates the
ElevenLabs API". After an award, "three.ws received an ElevenLabs Startup Grant", nothing stronger.

**After an award:** add `ELEVENLABS_API_KEY` to the Cloud Run service with `--update-env-vars` (as a
Secret Manager reference), confirm `/api/tts/catalog` flips the lane to `available: true`, then fix the
Voice Lab copy that describes platform metering, and add a `data/changelog.json` entry.
