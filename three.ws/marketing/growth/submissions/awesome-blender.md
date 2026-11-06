# Awesome Blender submission

Target: [agmmnn/awesome-blender](https://github.com/agmmnn/awesome-blender) (7,332 stars, last
merges 2026-01-22, 18 open PRs). The largest curated Blender resource list.

Contribution path: fork, edit `README.md`, open a pull request. Rules live in
[CONTRIBUTING.md](https://github.com/agmmnn/awesome-blender/blob/main/CONTRIBUTING.md).

Date verified: **2026-09-17**.

## Product

One product only: [`@three-ws/blender-mcp`](https://github.com/nirholas/three.ws/tree/main/packages/blender-mcp),
an MCP server that drives a locally installed Blender headlessly (`blender -b`) for an AI
assistant.

The in-repo three.ws Blender add-on (`integrations/blender`) was considered and not chosen: it is
still being edited and its Blender Extensions submission is tracked separately in
`opportunities.csv`.

## Why it fits

The list's audience is Blender artists and "developers and researchers who want to develop with
Blender". It has no entry for connecting an AI assistant to Blender. This server gives Claude,
Cursor, or any MCP client a real Blender with nothing installed into Blender itself: inspect a
file, convert between GLB, glTF, FBX, OBJ, STL, PLY, Collada, Alembic, USD and `.blend`, render
an auto-framed preview, run a `bpy` script, or import a model generated from a text prompt.
It is free and open source (Apache-2.0), which is what the list focuses on.

## Section

`## Standalone` > `### Various Tools`. The section is unordered; append at the bottom (after
`Particle Illusion`).

## Listing line

```markdown
- [three.ws Blender MCP](https://github.com/nirholas/three.ws/tree/main/packages/blender-mcp) : Model Context Protocol server that lets AI assistants drive a local Blender headlessly to inspect, convert, render, and script 3D files.
```

## Pull request title

```text
Add three.ws Blender MCP to Various Tools
```

## Pull request body

```markdown
Adds three.ws Blender MCP to Standalone > Various Tools.

It is a free, open-source (Apache-2.0) Model Context Protocol server that runs the Blender
already installed on your machine in background mode, one process per call, so an AI assistant
(Claude, Cursor, and other MCP clients) can:

- report the Blender version, render engines, and supported formats (`blender_info`)
- inspect a scene (`blender_scene_info`)
- convert between GLB, glTF, FBX, OBJ, STL, PLY, Collada, Alembic, USD and .blend (`blender_convert`)
- optimize a model (`blender_optimize`)
- render an auto-framed, auto-lit preview (`blender_render`)
- run a bpy script against a scene (`blender_run_python`)
- import a model generated from a text prompt (`blender_forge_import`)

No add-on to install and no GUI session, so it also works on servers and in CI.
Setup for Claude Code: `claude mcp add blender -- npx -y @three-ws/blender-mcp`
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | README fetched via GitHub API, searched for `three.ws`, `nirholas`, `threews`, `mcp` | no three.ws match and no MCP entry |
| No duplicate suggestion | `gh search prs` / `gh search issues` for `three.ws` and `nirholas` | 0 results |
| Source link is live | `curl -L` on the `packages/blender-mcp` tree URL | 200 |
| Package exists | `npm view @three-ws/blender-mcp` | 0.5.0, Apache-2.0, bin `blender-mcp` |
| Install works | `npm install @three-ws/blender-mcp` in a clean scratch project | succeeded |
| Tool list | stdio `initialize` + `tools/list` against the installed bin | `serverInfo.title: three.ws Blender`, tools `blender_info, blender_scene_info, blender_convert, blender_optimize, blender_render, blender_forge_import, blender_run_python` |
| Format list and headless design | Package README ("Requirements", intro) | Blender 3.0+, `blender -b`, formats as listed |

The scratch machine has no Blender binary, so the tools were listed but not executed against a
real Blender in this pass.

## Target rules complied with

- Format `[package](link) : Description.` with a capitalized description ending in a period.
- The link is the repository itself, so no separate repo badge is added (matching entries such
  as `AutoRemesher`).
- Free and open source; no `[$]` marker needed; not written as advertising.

## Owner's single action

Run `npx -y @three-ws/blender-mcp` once on a machine with Blender and call `blender_info` from
any MCP client, then fork, append the entry to Various Tools, and open the pull request.
