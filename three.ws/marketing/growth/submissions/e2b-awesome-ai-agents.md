# E2B Awesome AI Agents submission

Target: [e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) (30,042 stars,
last push 2026-08-21). One of the most visited AI agent directories on GitHub.

Contribution path: the README's "Submit new product here" link,
<https://forms.gle/UXQFCogLYrPFvfoUA>, a Google Form. The maintainers add entries from the form;
do not open a PR.

Date verified: **2026-09-17**.

## Product

One product only: **three.ws 3D Studio**, the free hosted MCP server at
`https://three.ws/api/mcp-studio` that lets any agent generate, rig, and refine 3D models
(docs: <https://three.ws/docs/mcp-studio>).

## Why it fits

The form's own description: "We accept (semi)-autonomous AI agents, agent SDKs, AI frameworks,
AI tools, or any other AI products built for or around AI agents." 3D Studio is a tool built for
agents: an agent calls it over MCP, gets back a downloadable GLB and a viewer link, and can
iterate on the model in plain language. The directory's Design and Art categories have no 3D
generation tool for agents.

## Form answers

Fields read from the live form on 2026-09-17.

| Field | Answer |
| --- | --- |
| Name of the product (required) | `three.ws 3D Studio` |
| Short tagline (required) | `Free MCP server that lets any AI agent turn text or an image into a rigged 3D model` |
| Please provide your e-mail (required) | `support@three.ws` |
| Choose the type | `Open-source` |
| Category | `Design`, `Art` |
| Add categories if not listed above | `3D generation` |
| Longer product description | see below |
| Webpage link | `https://three.ws/docs/mcp-studio` |
| GitHub link | `https://github.com/nirholas/three.ws` |
| X (Twitter), LinkedIn, founders' profiles | owner fills with the official accounts |
| Other links | `https://glama.ai/mcp/connectors/io.github.nirholas/threews-3d-studio-free` |
| Additional comments | `Endpoint https://three.ws/api/mcp-studio answers MCP initialize with no credentials; it is also in the official MCP Registry as io.github.nirholas/threews-3d-studio-free.` |
| Blog contribution topics | leave empty |

Longer product description:

```text
three.ws 3D Studio is a free, open-source Model Context Protocol server that gives AI agents a 3D
production pipeline. Any MCP client (Claude, ChatGPT developer mode, Cursor, or a custom agent)
connects to https://three.ws/api/mcp-studio with no account, API key, or payment. The agent can
generate a textured 3D model from a text prompt or a reference image, add a humanoid skeleton so
the model is animation-ready, generate and rig an avatar in one step, and refine a result with a
plain-language instruction. Every result comes back as a downloadable GLB plus a browser viewer
link, and renders inline in hosts that support MCP widgets.
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | README fetched via GitHub API (212 KB), searched for `three.ws`, `nirholas`, `threews`, `agent-3d` | 0 matches |
| Form fields | WebFetch of the redirected Google Form | fields as listed above |
| Open endpoint | `initialize` on `https://three.ws/api/mcp-studio` with no credentials | 200, `serverInfo.name: three-ws-3d-studio-free` |
| Tools | `tools/list` | `forge_free, text_to_avatar, mesh_forge, rig_mesh, forge_avatar, refine_model, check_job, look_at_model, create_agent_persona, get_agent_persona, persona_say` |
| Real generation | `forge_free {"prompt":"a brass desk lamp"}` then job polling | `done`, public `.glb` URL |
| Source is public | `curl -L https://github.com/nirholas/three.ws/blob/main/api/mcp-studio.js` | 200 (Apache-2.0 repo) |
| Docs live | `curl -L https://three.ws/docs/mcp-studio` | 200 |

The same endpoint is also prepared for the punkpeye remote MCP list
([pack](./awesome-remote-mcp-servers-punkpeye.md)). That is deliberate: one is an MCP
directory, this is a general AI agent directory with a different audience.

## Target rules complied with

- Submitted through the form the README links; no PR.
- Product matches the accepted types ("AI tools ... built for or around AI agents").
- Categories chosen from the form's list; the tagline follows the form's example style.

## Owner's single action

Open the form, paste the answers above, add the official social links, and submit.
