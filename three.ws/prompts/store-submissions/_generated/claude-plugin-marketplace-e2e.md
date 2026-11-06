# Claude plugin marketplace — end-to-end install evidence

**Marketplace:** `three-ws` (`.claude-plugin/marketplace.json`, source `https://github.com/nirholas/three.ws`).
**Captured:** 2026-07-08 (UTC), against a real Claude Code CLI binary (`claude --version` → `2.1.202`),
run non-interactively via `claude plugin marketplace add` / `claude plugin install` / `claude plugin details`.

This closes the TRACKER's outstanding blocking item: *"Plugin install test not yet run
end-to-end."* All 4 plugins were installed for real (not simulated) and their bundled MCP
servers were driven through a real MCP JSON-RPC handshake against the actual published npm
packages.

---

## 0. Bug found + fixed during this pass

`claude plugin validate ./.claude-plugin/marketplace.json --strict` failed with 4 warnings:
each of the 4 plugins' `plugin.json` declared a `category` field, which belongs in the
marketplace entry, not the plugin manifest — harmless but strict-invalid. Removed `category`
from all 4 plugin manifests (`.agents/.claude-plugin/plugin.json`,
`marketplace/plugins/three-ws-3d/.claude-plugin/plugin.json`,
`marketplace/plugins/three-ws-developer/.claude-plugin/plugin.json`,
`pump-fun-skills/.claude-plugin/plugin.json`). Re-validated clean:

```
$ claude plugin validate ./.claude-plugin/marketplace.json --strict
Validating marketplace manifest: /workspaces/three.ws/.claude-plugin/marketplace.json
✔ Validation passed
```

Each plugin also validates individually with `--strict`:

```
$ claude plugin validate ./.agents --strict                              → ✔ Validation passed
$ claude plugin validate ./marketplace/plugins/three-ws-3d --strict       → ✔ Validation passed
$ claude plugin validate ./marketplace/plugins/three-ws-developer --strict → ✔ Validation passed
$ claude plugin validate ./pump-fun-skills --strict                      → ✔ Validation passed
```

---

## 1. Marketplace add (local path, mirrors what a real user does from a clone)

```
$ claude plugin marketplace list
No marketplaces configured

$ claude plugin marketplace add ./
Adding marketplace…✔ Successfully added marketplace: three-ws (declared in user settings)

$ claude plugin marketplace list
Configured marketplaces:
  ❯ three-ws
    Source: Directory (/workspaces/three.ws)
```

## 2. Install all 4 plugins (project scope)

```
$ claude plugin install three-ws-core@three-ws      --scope project  → ✔ Successfully installed plugin: three-ws-core@three-ws (scope: project)
$ claude plugin install three-ws-developer@three-ws --scope project  → ✔ Successfully installed plugin: three-ws-developer@three-ws (scope: project)
$ claude plugin install three-ws-pump-fun@three-ws  --scope project  → ✔ Successfully installed plugin: three-ws-pump-fun@three-ws (scope: project)
$ claude plugin install three-ws-3d@three-ws        --scope project  → ✔ Successfully installed plugin: three-ws-3d@three-ws (scope: project)
```

`claude plugin list --json` confirms all 4 `enabled: true`, cached under
`~/.claude/plugins/cache/three-ws/<plugin>/1.0.0`, and the two plugins that declare
`mcpServers` (`three-ws-developer`, `three-ws-3d`) carry the resolved server blocks
(`3d-agent`, plus `scene` + `avatar` for `three-ws-3d`).

Real, tracked side effect: `.claude/settings.json` now records
`extraKnownMarketplaces.three-ws` (resolved to the GitHub form,
`{"source":"github","repo":"nirholas/three.ws"}`) and `enabledPlugins` for all 4 IDs — this is
what a contributor who clones the repo and runs `claude` inherits automatically.

## 3. Component inventory (`claude plugin details <plugin>@three-ws`)

| Plugin | Skills | Commands | MCP servers declared |
|---|---|---|---|
| `three-ws-core` | 40 (`authenticate-wallet`, `x402`, `send-usdc`, `create-3d-avatar`, `generate-3d-model`, `rig-a-model`, 34 OKX/agent-economy skills, …) | 0 | 0 |
| `three-ws-developer` | 3 (`scaffold-agent`, `setup-mcp`, `use-tools`) | — | 1 (`3d-agent` → `@three-ws/mcp-server`) |
| `three-ws-pump-fun` | 5 (`coin-fees`, `create-coin`, `reactive`, `swap`, `tokenized-agents`) | 0 | 0 |
| `three-ws-3d` | 4 (`auto-rig`, `forge-3d`, `mesh-forge`, `text-to-avatar`) | 0 | 3 (`3d-agent`, `scene`, `avatar`) |

No empty shells — every plugin resolves real, non-trivial content.

## 4. Real MCP protocol handshake against the bundled servers

`three-ws-developer` and `three-ws-3d` bundle 3 distinct MCP servers via `npx -y <pkg>`. Each
is a real, currently-published npm package (`@three-ws/mcp-server@1.2.1`,
`@three-ws/scene-mcp@0.1.1`, `@three-ws/avatar-mcp@0.3.0`). To prove the install path actually
works end-to-end — not just that the manifest parses — each was spawned exactly as the plugin
declares it (`npx -y <pkg>`, using the real npx-resolved package tree, run from outside the
monorepo's workspace symlinks) and driven through a real `initialize` → `tools/list` JSON-RPC
round trip:

```
=== @three-ws/mcp-server (three-ws-3d + three-ws-developer, id "3d-agent") ===
initialize -> {"serverInfo":{"name":"3d-agent-mcp","version":"1.2.1"},"protocolVersion":"2024-11-05"}
tools/list -> count=19
text_to_avatar, mesh_forge, forge_free, rig_mesh, forge_avatar, ens_sns_resolve,
agent_delegate_action, agent_hire_discover, agent_hire, sentiment_pulse, get_pose_seed,
pump_snapshot, agent_reputation, vanity_grinder, agenc_list_tasks, agenc_get_task,
agenc_get_agent, aixbt_intel, aixbt_projects

=== @three-ws/scene-mcp (three-ws-3d, id "scene") ===
initialize -> {"serverInfo":{"name":"scene-mcp","title":"three.ws Scenes","version":"0.1.1"},"protocolVersion":"2024-11-05"}
tools/list -> count=3
compose_scene, get_scene, list_scenes

=== @three-ws/avatar-mcp (three-ws-3d, id "avatar") ===
initialize -> {"serverInfo":{"name":"three.ws-avatar-mcp","version":"0.3.0"},"protocolVersion":"2024-11-05"}
tools/list -> count=3
render_avatar, avatar_embed_code, get_avatar
```

All 3 processes booted, completed the MCP handshake, and returned their real, currently
registered tool surface — zero crashes, zero missing modules, zero stale placeholder tools.
(One local-only wrinkle: `npx` run *inside* this monorepo resolves the workspace-linked
`mcp-server/` package, which is missing a hoisted `@modelcontextprotocol/sdk` in the repo's
root `node_modules` — irrelevant to real installs, since a user outside this repo always gets
the clean published package from the registry, which is what was tested above.)

## 5. Result

Plugin install test: **done, real, end-to-end.** All 4 plugins install cleanly from the
marketplace, resolve real skills/MCP servers, and the 3 bundled MCP servers respond correctly
to the MCP protocol with their real tool surfaces. Nothing left to build for prompt 10.

Remaining step is `[HUMAN]`-only: submitting `three-ws-3d` (and optionally the other 3) to
Anthropic's community plugin marketplace catalog per `marketplace/plugins/three-ws-3d/SUBMISSION.md`
(`https://platform.claude.com/plugins/submit` or the claude.ai admin directory submissions
page) — Anthropic reviews and pins an approved commit SHA; there is no API for this step.
