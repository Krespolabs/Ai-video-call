# Hacktoberfest 2026 Fest: host application (Hack Day and Meetup)

**Status:** both variants drafted. The owner fills the four marked inputs, picks one format, and
submits. Nothing has been submitted.
**Apply at:** https://hacktoberfest.com/host (the application itself is at https://hacktoberfest.com/my/,
behind an MLH sign-in, so its exact field labels could not be read; the items below follow MLH's own
description: "The application will ask about your organization, proposed event, format, venue, and
program").
**Verified:** 2026-09-17 against https://hacktoberfest.com/, https://hacktoberfest.com/host/, and the
MLH host handbook at https://hacktoberfest-handbook.mlh.com/ (reimbursement page "Last reviewed: 15
September 2026"). Open good-first-issue count re-checked 2026-09-18.
**Deadline:** none fixed. MLH asks for "at least a few weeks' notice; ideally, apply four weeks in
advance", a confirmed date inside the October window, and confirms Fests "within a week of a completed
application". Late applications "may" be converted to a November Hack Day.

---

## Owner-only inputs (the only blanks)

| Input | Constraint from MLH |
|---|---|
| **VENUE** (name and street address) | In person, "safe, accessible", reliable Wi-Fi, power outlets, seating, tables, screens or projectors, microphones when appropriate |
| **CITY** | One Fest per organization per city or metro area |
| **CAPACITY** | No enforced minimum or maximum; MLH says 25 to 50 is ideal and reimbursement caps at 50 check-ins |
| **HOST NAME** (and public host contact email) | Shown on the OrganizerHQ event page |

## Decisions already made (reversible)

- **Date:** Saturday **2026-10-24**, alternate Saturday **2026-10-17**. Applying by 2026-09-26 gives
  MLH the requested four weeks for the primary date. The alternate is already inside four weeks, so it
  depends on MLH accepting short notice "on a case-by-case basis".
- **Recommended format: Hack Day.** A Hack Day is the format that produces public, open-source
  projects, which is what Hacktoberfest 2026 is about. Choose the Meetup if the venue cannot hold a
  five-hour build.
- **No food reimbursement for a company host.** MLH's reimbursement page: reimbursement is "available
  only for approved Hacktoberfest Hack Day events hosted by individuals, school clubs, or community
  organizations. Corporate hosts and Hacktoberfest Meetup events are not eligible." If three.ws the
  company hosts, food is paid by three.ws. If a community organizer applies as an individual, the
  maximum is the lower of itemized spend or the country per-hacker rate times verified in-person
  check-ins, capped at 50 (MLH's US example: 30 check-ins, maximum 210 USD). A Meetup gets no
  reimbursement either way. The owner decides who hosts; the answers below work in both cases.
- **Partner prize preference (Hack Day only):** leave blank. MLH assigns partner categories; the event
  does not need one.

---

## The 2026 theme: open-source AI, not pull-request counting

Hacktoberfest 2026 no longer centres on counting pull requests. hacktoberfest.com describes
"high-value, meaningful learning", names examples such as writing a first skills file, building an
open-source agent, and fine-tuning an open-weight model, and cites maintainer burnout from low-effort
AI-generated PRs. A Fest is "an official, in-person Hacktoberfest event lasting up to 12 hours, designed
to bring local developer communities together to learn and build with open-source AI."

Every Hack Day runs MLH's **Best Open-Source AI Project** challenge. Its requirements: open-source or
open-weight AI must be "an important part of the project"; the project must be "published in a public
GitHub repository and use an open-source license"; an agent skill "must comply with the Agent Skill
Open Standard". One winning team; every member gets a DEV Badge.

three.ws fits that brief with things that exist today:

| Asset | Verified fact (2026-09-17) |
|---|---|
| The monorepo | https://github.com/nirholas/three.ws, Apache-2.0 (`LICENSE`) |
| A starter for new projects | https://github.com/nirholas/threews-agent-starter: GitHub API reports `is_template: true`, license Apache-2.0 |
| Agent skills in the open format | 45 entries under `.agents/skills/`, indexed by `.agents/skills/SKILLS.md`, which cites the Agent Skills spec at agentskills.io. `generate-3d-model/SKILL.md` declares `license: MIT` and uses the free, keyless text-to-3D lane |
| Open-weight 3D models on the platform's own GPU fleet | `workers/model-trellis` (TRELLIS; its README states an MIT license), `workers/model-hunyuan3d` (Hunyuan3D-2.1, under the Tencent Hunyuan non-commercial license per its README), `workers/model-triposg`, `workers/rig` |
| Free generation for attendees | `https://three.ws/forge` needs no account. `GET /api/forge?catalog` listed TRELLIS (free), Hunyuan3D / TRELLIS (free), Hunyuan3D, TRELLIS (self-host), and TripoSG as `free: true`, `configured: true` |
| Ready first contributions | Seven issue bodies, each verified against `main` on 2026-09-17, in [events/osf-issues/](../events/osf-issues/) and indexed in the [Open Source Friday menu](../events/open-source-friday-menu.md) |

**Caveat to state to teams:** Hunyuan3D-2.1 is open-weight but non-commercial. A team that uses it
names the model and links its license in the README, as the challenge asks.

---

## Variant A: Hacktoberfest Hack Day

| Application item | Answer |
|---|---|
| Organization | three.ws (or the HOST NAME if applying as an individual organizer) |
| Event name | `three.ws Open Agents - CITY [Hack Day]` (MLH format: `{Organization or Event Name} - {Location} [Hack Day]`) |
| Format | Hacktoberfest Hack Day |
| Date and time | Saturday 2026-10-24, 11:00 to 16:30 local (5.5 hours; MLH requires 3 to 12, "four to six hours is ideal") |
| Venue | **VENUE, CITY** |
| Expected attendance | **CAPACITY** (recommend 30 to 50) |
| Cost to attend | Free (required for Hack Days) |
| Host and contact | **HOST NAME**, public host contact email |
| Registration, check-in, submissions | OrganizerHQ (required); projects through OrganizerHQ Challenges |
| Code of conduct | MLH Code of Conduct, https://github.com/MLH/mlh-policies/blob/main/code-of-conduct.md |
| Rules | MLH Standard Hackathon Rules: project-specific work starts at the opening |
| Participant age | 13 and older (Hacktoberfest rule) |
| Food | Provided by the host; see the reimbursement decision above |

**About the community (paste):**

> three.ws is an open-source (Apache-2.0) platform that gives AI agents a body: a text prompt becomes a
> textured, rigged, animated 3D character that can be embedded on any web page. Our contributors and
> users are web developers, 3D artists, and people building AI agents. This Hack Day brings them
> together in person to build open-source agents that can be seen, not just read.

**Program (paste; this is MLH's Hack Day template, filled):**

> Join three.ws for three.ws Open Agents - CITY [Hack Day], a one-day, in-person Hacktoberfest event
> where participants will build with open-source or open-weight AI, submit through OrganizerHQ
> Challenges, and compete in the Best Open-Source AI Project challenge. Build an agent skill in the open
> Agent Skills format, give an open-source agent a 3D body using open-weight text-to-3D models, or make
> your first contribution to an Apache-2.0 3D agent platform. Generation is free and needs no account
> or API key. Bring your laptop with Node.js installed, a GitHub account, and your curiosity!

**Project prompts (for the opening slides):**

1. **An agent skill.** A `SKILL.md` folder that lets any agent create or inspect 3D models. Reference:
   `.agents/skills/generate-3d-model/`.
2. **An open-source agent with a body.** Start from the `threews-agent-starter` template and connect it
   to an open-weight model.
3. **A harness or pipeline improvement.** For example, a tool that runs an open-weight text-to-3D model
   and validates the GLB it returns.

### Hack Day run of show

| Time | Segment | Detail |
|---|---|---|
| 10:15 | Doors, OrganizerHQ check-in | Only in-person check-ins at the venue count |
| 11:00 | Opening (15 min) | Code of conduct, Wi-Fi, the challenge requirements, submission deadline, photo consent |
| 11:15 | Live demo (15 min) | Prompt to rigged avatar on `three.ws/forge`, then that avatar in a plain HTML page |
| 11:30 | Build starts | Teams form. One table runs the contribution lane below for anyone who wants a scoped task |
| 12:00 | Setup clinic (30 min) | `git clone`, `npm install`, `npm run setup`, `npm run dev`, per [docs/first-contribution.md](../../../docs/first-contribution.md) |
| 13:00 | Lunch | Paid per the reimbursement decision |
| 13:30 | Workshop (20 min) | Writing a `SKILL.md` another agent can load |
| 15:30 | Submissions close | Public GitHub repo, open-source license, model named and licensed, submitted in OrganizerHQ |
| 15:30 | Demos (2 min per team) | Show the code and explain what the AI does |
| 16:15 | Winner, photos | Host marks one winning team in OrganizerHQ, makes the gallery public, then announces |
| 16:30 | Close | Maintainers review any contribution-lane PRs opened today |

### The contribution lane: the seven committed issue bodies

`gh issue list --repo nirholas/three.ws --label "good first issue"` returned `[]` on 2026-09-17 and
again on 2026-09-18: the repo has **no open good first issues**, because #110 to #114 were all closed as
completed on 2026-09-14 and 2026-09-15. The lane reuses the seven bodies already written and verified
for Open Source Friday. No new issues are invented here.

| # | Task | Size (from the menu) | Proof command (from the body) |
|---|---|---|---|
| 1 | [Rig: HumanIK names after three.js strips the colon](../events/osf-issues/01-rig-humanik-sanitized-names.md) | Small | `npx vitest run tests/glb-canonicalize.test.js` |
| 2 | [Rig: 3ds Max Biped finger chains](../events/osf-issues/02-rig-biped-finger-chains.md) | Small | `npx vitest run tests/glb-canonicalize.test.js` |
| 3 | [Rig: Source engine `ValveBiped` skeletons and Rig Doctor](../events/osf-issues/03-rig-source-engine-valvebiped.md) | Medium; after task 2 | `npx vitest run tests/glb-canonicalize.test.js tests/rig-report.test.js` |
| 4 | [Upload check skips the declared GLB length](../events/osf-issues/04-glb-magic-declared-length.md) | Small | `npx vitest run tests/glb-magic.test.js` |
| 5 | [Tests: URL scheme guards](../events/osf-issues/05-tests-url-scheme-guards.md) | Small; no 3D knowledge | `npx vitest run tests/url-scheme-guards.test.js` |
| 6 | [Tests: model URL allowlist](../events/osf-issues/06-tests-model-url-allowlist.md) | Small; no 3D knowledge | `npx vitest run tests/safe-model-url.test.js` |
| 7 | [Money Pulse: compact numbers roll into the wrong unit](../events/osf-issues/07-pulse-format-unit-rollover.md) | Small | `npx vitest run tests/pulse-format.test.js` |

Re-probed on 2026-09-17: `Character1Hips`, `Character1_Hips`, `Bip01 L Finger0`, and
`ValveBiped.Bip01_Pelvis` each return `null` from `canonicalizeBoneName`, so tasks 1 to 3 were still open.

**Maintainer prep (T-7):** re-run each body's probe, file the still-open ones as issues with the
`good first issue` label, and drop any that Open Source Friday closed. Contribution-lane PRs are a
learning track; they are not a Best Open-Source AI Project entry unless a team's project qualifies on
its own.

---

## Variant B: Hacktoberfest Meetup

| Application item | Answer |
|---|---|
| Organization | three.ws (or HOST NAME) |
| Event name | `three.ws Open Agents - CITY [Meetup]` |
| Format | Hacktoberfest Meetup |
| Date and time | Saturday 2026-10-24, 14:00 to 17:00 local |
| Venue | **VENUE, CITY** |
| Expected attendance | **CAPACITY** (recommend 25 to 40) |
| Host and contact | **HOST NAME**, public host contact email |
| Registration and check-in | OrganizerHQ (required) |
| Code of conduct | MLH Code of Conduct |
| Food | Optional, paid by the host; Meetups receive no reimbursement and no prizes |

**Plans for the format (paste; MLH asks Meetup hosts for this):**

> A three-hour afternoon on open-source AI agents that have a visible body. A 20-minute talk shows how
> an Apache-2.0 platform turns a text prompt into a rigged, animated 3D character with open-weight
> text-to-3D models on its own GPU fleet. A 45-minute guided workshop walks everyone through writing an
> agent skill in the open Agent Skills format. The last hour is a contributor clinic where attendees
> pick one of seven pre-scoped, verified tasks in the repository and leave with a branch or a pull
> request. No prizes or project submissions; Hacktoberfest swag is distributed to attendees.

**Description (MLH's Meetup template, filled):**

> Join three.ws for three.ws Open Agents - CITY [Meetup], a one-day, in-person Hacktoberfest gathering
> focused on open-source and open-weight AI. The program will include a talk, a hands-on workshop, and
> a contributor clinic. Come meet other members of the community, exchange ideas, and explore how open
> technology is changing the way we build.

### Meetup run of show

| Time | Segment |
|---|---|
| 13:30 | Doors, OrganizerHQ check-in |
| 14:00 | Welcome and code of conduct (10 min) |
| 14:10 | Talk: "Give an agent a body" (20 min), live on `three.ws/forge` and `three.ws/rig-doctor` |
| 14:30 | Workshop: write and load a `SKILL.md` (45 min) |
| 15:15 | Break, swag |
| 15:30 | Contributor clinic (60 min) on the seven tasks above |
| 16:30 | Show and tell: what attendees opened (20 min) |
| 16:50 | Photos, close |

---

## Obligations after approval (both formats)

- OrganizerHQ event page: approved name, exact times, venue address and arrival instructions, a public
  host email, schedule, accessibility information, food information, what to install.
- Distribute the supplied swag and keep it separate from prizes.
- Photos only with attendee permission, per MLH's photography guidance.
- Afterwards: photos, event summary, attendance. Hack Day adds: winner marked in OrganizerHQ, public
  gallery before announcing, itemized receipts through Ramp only if the host is reimbursement-eligible.
- MLH contact: hacktoberfest@mlh.io.

## Relationship wording

Hacktoberfest is run by MLH with DEV. Say nothing public before approval. After approval the event is
"an official Hacktoberfest 2026 Fest hosted by three.ws", under MLH's approved event name. Do not call
MLH, DEV, or any Hacktoberfest sponsor a three.ws partner.
