# mcpservers.org (wong2 Awesome MCP Servers) submission

Target: [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) (4,314 stars,
last push 2026-07-13) and the directory it feeds, <https://mcpservers.org>.

Contribution path: the README's first line says "We do not accept PRs. Please submit your MCP
on the website: https://mcpservers.org/submit". Use that form. Do not open a PR.

Date verified: **2026-09-17**.

## Product

One product only: [`@three-ws/scene-mcp`](https://github.com/nirholas/three.ws/tree/main/packages/scene-mcp),
the stdio MCP server that turns one sentence into a placed 3D diorama.

## Why it fits

The directory is where MCP users browse by category for servers to install. Scene composition
from language is not covered by any server in the wong2 README, and this one has no friction to
try: no API key, no account, no payment, one `npx` line. The separate
[punkpeye pack](./awesome-mcp-servers.md) lists `@three-ws/mcp-server`, so each directory gets a
different three.ws server.

## Form answers

Fields read from the live form on 2026-09-17.

| Field | Answer |
| --- | --- |
| Server Name (required) | `three.ws Scenes` |
| Category (required) | `Design` |
| Short Description (required) | `Turn one sentence into a placed 3D world: compose a scene plan, forge every object, and export one glTF binary. No API key.` |
| Repository, Website or Documentation (required) | `https://github.com/nirholas/three.ws/tree/main/packages/scene-mcp` |
| Official MCP Registry Name (optional) | `io.github.nirholas/scene-mcp` |
| This server supports remote connections | leave off (stdio server) |
| Contact Email (required) | `support@three.ws` |
| Submission tier | **Free** (review "within 2 weeks"). The $39 Premium Submit is a spend decision outside this pack. |

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already in the wong2 README | README fetched via GitHub API, searched for `three.ws`, `nirholas`, `threews` | 0 matches |
| Not already on mcpservers.org | Site search is behind a Cloudflare challenge (403 to curl and WebFetch) | not verifiable automatically; the owner checks site search before submitting |
| Form fields and tiers | WebFetch of `https://mcpservers.org/submit` | fields and Free / $39 tiers as listed above |
| Repo path is live | `curl -L` on the `packages/scene-mcp` tree URL | 200 |
| Package exists | `npm view @three-ws/scene-mcp` | 0.2.2, Apache-2.0, bin `scene-mcp` |
| Install works | `npm install @three-ws/scene-mcp` in a clean scratch project | succeeded |
| Server starts and lists tools | stdio `initialize` + `tools/list` against the installed bin | `serverInfo.title: three.ws Scenes`, tools `compose_scene, get_scene, list_scenes, export_scene, build_world` |
| Works with no key | `tools/call compose_scene {"prompt":"a cozy wizard library with floating candles"}` | `ok: true`, a titled diorama ("Wizard's Nook") with mood, palette, ground, and positioned object prompts |
| Registry name | `registry.modelcontextprotocol.io/v0/servers?search=scene-mcp` | `io.github.nirholas/scene-mcp` (0.1.0 through 0.2.1 published) |

## Target rules complied with

- Submitted through the website form the README names; no PR.
- Category chosen from the form's own list.
- Free tier, so the pack commits no spend.

## Owner's single action

Search mcpservers.org for "three.ws" to confirm no existing listing, then submit the free form
with the answers above.
