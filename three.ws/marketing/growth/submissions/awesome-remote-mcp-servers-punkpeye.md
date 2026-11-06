# Awesome Remote MCP Servers (punkpeye) submission

Target: [punkpeye/awesome-remote-mcp-servers](https://github.com/punkpeye/awesome-remote-mcp-servers)
(248 stars, last push 2026-09-15, three additions merged on 2026-09-15 alone).

This is a different list from [punkpeye/awesome-mcp-servers](./awesome-mcp-servers.md), which
only accepts install-and-run servers and explicitly sends hosted endpoints here. The two packs
do not overlap: that one lists the npm server, this one lists a hosted URL.

Contribution path: star the repo, fork, edit `README.md`, open a pull request. Rules live in
[CONTRIBUTING.md](https://github.com/punkpeye/awesome-remote-mcp-servers/blob/main/CONTRIBUTING.md).

Date verified: **2026-09-17**.

## Product

One product only: the hosted **three.ws 3D Studio (free)** MCP endpoint,
`https://three.ws/api/mcp-studio` (docs: <https://three.ws/docs/mcp-studio>, registry name
`io.github.nirholas/threews-3d-studio-free`).

## Why it fits

The list only takes servers anyone can reach by URL, answering `initialize` with no per-user
endpoint and no paywall in front of the handshake. This endpoint is open (no account, no key,
no payment) and turns a text prompt or an image into a downloadable GLB. The Art & Design section
today has one parametric CAD server and nothing that generates a 3D model from language.

## Section

`### Art & Design` (the heading carries the list's palette emoji), alphabetical and
case-insensitive: after `OwlCAD`, the last entry.

## Listing line

```markdown
- [three.ws 3D Studio](https://three.ws/docs/mcp-studio) `https://three.ws/api/mcp-studio`
  [![three.ws 3D Studio MCP connector](https://glama.ai/mcp/connectors/io.github.nirholas/threews-3d-studio-free/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.nirholas/threews-3d-studio-free)
  🔓 - Turn a text prompt or an image into a textured, rigged, downloadable 3D model (GLB).
```

The description is 86 characters, under the 120 limit. The open-padlock emoji is the list's
mandatory authentication marker (no authentication), not decoration.

## Pull request title

```text
Add three.ws 3D Studio to Art & Design
```

The list documents a fast-track marker for PRs opened by automated agents. Leave it off: the
owner opens this PR by hand.

## Pull request body

```markdown
Adds three.ws 3D Studio to Art & Design.

- Endpoint: `https://three.ws/api/mcp-studio` (Streamable HTTP, JSON-RPC over POST)
- Auth: none. No account, no API key, no payment.
- Tools: forge_free (text to 3D), text_to_avatar, mesh_forge, rig_mesh (make a static model
  animation-ready), forge_avatar (generate plus rig), refine_model, check_job, look_at_model,
  create_agent_persona, get_agent_persona, persona_say
- Glama connector: https://glama.ai/mcp/connectors/io.github.nirholas/threews-3d-studio-free
- Docs: https://three.ws/docs/mcp-studio
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | README fetched via GitHub API, searched for `three.ws`, `nirholas`, `threews` | 0 matches |
| No duplicate suggestion | `gh search prs` / `gh search issues` for `three.ws` and `nirholas` | 0 results |
| Answers `initialize` | `POST https://three.ws/api/mcp-studio` with an `initialize` request, no credentials | 200, `serverInfo.name: three-ws-3d-studio-free`, protocol `2025-06-18` |
| Tool list | `tools/list` on the same endpoint | the eleven tools named above |
| Generation works with no auth | `tools/call forge_free {"prompt":"a brass desk lamp"}`, then polled the returned job URL | `done` on the third poll with a public `.glb` URL |
| Glama connector exists (CI requirement) | `curl` on the connector page and `badges/score.svg`; a made-up connector name returns 404 for comparison | page 200, badge 200, badge title "three.ws 3D Studio (free) MCP connector rated A on Glama" |
| Docs page is live | `curl -L https://three.ws/docs/mcp-studio` | 200 |
| Registry entry | `registry.modelcontextprotocol.io/v0/servers?search=threews-3d-studio` | `io.github.nirholas/threews-3d-studio-free` 1.0.1, remote `https://three.ws/api/mcp-studio` |

Generation is rate limited per caller (the docs note a shared generation quota). The handshake
and `tools/list` are never gated, which is what the list's CI checks.

## Target rules complied with

- Reachable public URL that answers `initialize`; usable by anyone; Streamable HTTP.
- Listed as a Glama connector, badge included on line two.
- Three-line entry format, name linked to documentation (not a GitHub repo), endpoint in
  backticks, auth marker, one-sentence description ending in a period, under 120 characters.
- Alphabetical within the category; one server per entry.
- The account opening the PR must have starred the repo (required for merge).

## Owner's single action

Star the repo from the GitHub account that will open the PR, then fork, paste the entry after
`OwlCAD`, and open the pull request.
