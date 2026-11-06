# Awesome Remote MCP Servers (jaw9c) submission

Target: [jaw9c/awesome-remote-mcp-servers](https://github.com/jaw9c/awesome-remote-mcp-servers)
(1,117 stars, last push 2026-06-23, last merged additions 2026-06-19 and 2026-06-23). A separate
list from the punkpeye one of the same name, with its own opinionated bar favouring official,
OAuth-protected servers.

Contribution path: fork, add a row to the README table, open a pull request whose description
covers the quality criteria. Rules live in
[CONTRIBUTING.md](https://github.com/jaw9c/awesome-remote-mcp-servers/blob/main/CONTRIBUTING.md).

Date verified: **2026-09-17**.

## Product

One product only: the official hosted **three.ws** MCP server, `https://three.ws/api/mcp`
(docs: <https://three.ws/docs/mcp>, registry name `io.github.nirholas/three.ws`). This is the
OAuth server. The free no-auth studio endpoint goes to the
[punkpeye pack](./awesome-remote-mcp-servers-punkpeye.md), so each list gets a different product.

## Why it fits

The list's bar is "officially supported, production ready, OAuth 2.0 preferred". This server is
operated by three.ws itself, protects every call with OAuth 2.1 (authorization code with PKCE and
dynamic client registration, advertised through standard discovery documents), and gives an
assistant a user's own 3D avatar library plus the Khronos glTF-Validator. The table has Canva
under Design and no 3D server at all.

## Section

The single table under `## Remote MCP Server List`. It is roughly alphabetical; insert the row
after `ThoughtSpot` and before `Turkish Airlines`.

## Listing line

```markdown
| three.ws | Design | `https://three.ws/api/mcp` | OAuth2.1 | [three.ws](https://three.ws) |
```

## Pull request title

```text
Add three.ws remote MCP server
```

## Pull request body

```markdown
Adds three.ws, the official remote MCP server for three.ws 3D avatars.

**What it does.** Lets an assistant browse and search the signed-in user's 3D avatar library,
render an avatar as an interactive viewer, run the Khronos glTF-Validator against any public
glTF or GLB URL, inspect mesh, texture, and animation counts, and get optimization suggestions.
Tool reference: https://three.ws/docs/mcp

**Why it meets the quality criteria**
- Official support: operated and maintained by three.ws. Source is public at
  https://github.com/nirholas/three.ws (Apache-2.0), with commits landing daily.
- Production ready: live at `https://three.ws/api/mcp` and published in the official MCP
  Registry as `io.github.nirholas/three.ws`.
- Security: OAuth 2.1 per the MCP authorization spec. Unauthenticated calls get `401` with a
  `WWW-Authenticate` header pointing at `https://three.ws/.well-known/oauth-protected-resource`.
  The authorization server metadata at `https://three.ws/.well-known/oauth-authorization-server`
  advertises authorization code and refresh token grants, S256 PKCE, and dynamic client
  registration.
- Support: GitHub issues at https://github.com/nirholas/three.ws/issues and support@three.ws.
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | README fetched via GitHub API, searched for `three.ws`, `nirholas`, `threews` | 0 matches |
| No duplicate suggestion | `gh search prs` / `gh search issues` for `three.ws` and `nirholas` | 0 results |
| OAuth-protected | `POST https://three.ws/api/mcp` `initialize` with no token | `401`, `www-authenticate: Bearer resource_metadata="https://three.ws/.well-known/oauth-protected-resource"` |
| Protected resource metadata | `curl https://three.ws/.well-known/oauth-protected-resource` | `resource: https://three.ws/api/mcp`, `authorization_servers: ["https://three.ws"]` |
| Authorization server metadata | `curl https://three.ws/.well-known/oauth-authorization-server` | 200; `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, `authorization_code` and `refresh_token` grants |
| Registry entry | `registry.modelcontextprotocol.io/v0/servers?search=io.github.nirholas/three.ws` | 1.0.1, remote `https://three.ws/api/mcp` |
| Docs are live | `curl -L https://three.ws/docs/mcp` | 200 |
| Tool capabilities | `docs/mcp.md`, "What is MCP?" section | avatar library, inline viewer, glTF-Validator, inspection, optimization suggestions |

The server exposes more account tools than the description names (listed in the docs). The PR
describes only the 3D surface on purpose: that is what the Design category row is for.

## Target rules complied with

- Row uses the exact five columns: name, category, URL in backticks, authentication, maintainer
  linked to the official website.
- OAuth authentication following the MCP spec.
- PR description covers why the server meets the criteria, production use, features,
  repository, maintenance evidence, security measures, and support channels.

## Owner's single action

Fork the repo, add the row after `ThoughtSpot`, and open the pull request with the body above.
