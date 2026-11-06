# Partner program application packages

Send-ready, fact-checked application packages. Each file maps the program's form to paste-ready
answers, cites the source of every claim (code path, live URL, or read-only query), and leaves blank only
the fields the owner alone can fill. Nothing in this directory has been submitted, sent, or posted;
every submission is an owner action.

Status lines here mirror [opportunities.csv](../opportunities.csv), which is where a status changes
first. Background packets for Google Cloud and ElevenLabs live in
[marketing/partner-packets/](../../partner-packets/README.md); the files here extend them rather than
repeat them.

## Index

| Package | Program and form | Deadline | Verdict | Owner-only fields |
|---|---|---|---|---|
| [google-cloud-ai-agents.md](./google-cloud-ai-agents.md) | Google Cloud Partner Network enrollment (https://partners.cloud.google.com/enrollment), AI Agent Ecosystem Program form, Marketplace Producer Portal | None published; pipeline target 2026-09-25 | Enroll now. The A2A listing is blocked by the Vertex AI billing denial and the Agent Card gaps listed in the file | Legal entity and incorporation, Partner Administrator account, payments profile, Vendor Agreement signatory, headcount and funding if asked |
| [elevenlabs-startup-grants.md](./elevenlabs-startup-grants.md) | ElevenLabs Startup Grants (https://elevenlabs.io/grants-application) | Rolling; pipeline target 2026-09-24 | Conditional go: integration is real but runs only on a user's own key today | Employee count (must be under 25), applicant and business email, team and founder bio, entity and country, terms acceptance, decision on the 13+ Terms of Service versus the "no projects for minors" rule |
| [hacktoberfest-2026-fest.md](./hacktoberfest-2026-fest.md) | Hacktoberfest 2026 Fest host application (https://hacktoberfest.com/host), Hack Day and Meetup variants | No fixed deadline; apply by 2026-09-26 for the 2026-10-24 date (MLH asks for four weeks) | Ready once a venue exists. Company hosts get no food reimbursement | VENUE, CITY, CAPACITY, HOST NAME and public host email; which format; who hosts |
| [creator-grant-proposal.md](./creator-grant-proposal.md) | three.ws Creator Grant public terms, then a CloudCredits listing (https://github.com/t3-sh/cloudcredits.io) | Pipeline target 2026-10-02 | **PROPOSAL pending owner decision** | Go or no-go, amount and cohort size, expiry, issuing path, reviewer |
| [digitalocean-startups-memo.md](./digitalocean-startups-memo.md) | DigitalOcean Startups (https://www.digitalocean.com/startups) | None | **No-go:** three.ws does not use DigitalOcean | None unless reopened |
| [mongodb-for-startups-memo.md](./mongodb-for-startups-memo.md) | MongoDB for Startups (https://www.mongodb.com/solutions/startups) | None | **No-go:** the program requires MongoDB Atlas; three.ws runs on Postgres | None unless reopened |
| [gated/](./gated/) (two packages) | Two ecosystem grant and program applications that name crypto projects other than $THREE | See each file | Held under the commit gate in `CLAUDE.md`; each file states its own status | See each file |

## Rules these packages follow

- Partner relationships use the exact wording in [docs/partners.md](../../../docs/partners.md). No
  package calls three.ws a partner of a program it has not been accepted into.
- No invented metrics. A figure appears with its source and capture date; a figure that is not measured
  says so and shows the command that would measure it.
- Re-run the figures on the day a package is sent. The refresh commands are in each file and in the
  [partner-packets README](../../partner-packets/README.md#keeping-these-current).
- After sending, record the date and any receipt in the package header and move the matching row in
  [opportunities.csv](../opportunities.csv).
