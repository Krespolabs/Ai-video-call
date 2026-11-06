# Awesome Web Components submission

Target: [web-padawan/awesome-web-components](https://github.com/web-padawan/awesome-web-components)
(3,580 stars, last push 2026-09-12, most recent merged additions 2026-08-17, 2026-08-27 and
2026-09-09).

Contribution path: fork, edit `README.md`, open one pull request. Rules live in
[CONTRIBUTING.md](https://github.com/web-padawan/awesome-web-components/blob/main/CONTRIBUTING.md).

Date verified: **2026-09-17**.

## Product

One product only: the `<agent-3d>` custom element, shipped as
[`@three-ws/avatar`](https://github.com/nirholas/three.ws/tree/main/avatar-sdk) and as a
script-tag loader at `https://three.ws/agent-3d/latest/agent-3d.js`.

## Why it fits

The list's **Real World > Components** section catalogues standalone, framework-agnostic
custom elements that do one job, including `<model-viewer>` for static 3D models. `<agent-3d>`
is the same shape of thing for animated humanoid avatars: one tag, a GLB URL, no build step, and
opt-in chat, voice, and lipsync. Web component builders who reach `<model-viewer>` and need a
character that moves are exactly the reader this entry serves.

## Section

`## Real World` > `### Components`, alphabetical by tag name: directly after
``[`<active-table>`]`` and before ``[`<api-viewer>`]``.

## Listing line

```markdown
- [`<agent-3d>`](https://github.com/nirholas/three.ws/tree/main/avatar-sdk) - Web component that renders an animated 3D avatar from a GLB, with optional chat, voice, and lipsync.
```

## Pull request title

```text
Add <agent-3d> to Components
```

## Pull request body

```markdown
Adds `<agent-3d>` to Real World > Components, in alphabetical order.

`<agent-3d>` is a custom element for animated 3D avatars. A bare
`<agent-3d body="https://example.com/avatar.glb">` renders an animated character with no API key
and no framework; chat, voice input and output, and audio-driven lipsync are opt-in attributes.
It sits next to `<model-viewer>` in purpose: model-viewer shows an object, agent-3d shows a
character that moves.

- Source: https://github.com/nirholas/three.ws/tree/main/avatar-sdk (Apache-2.0)
- npm: `npm install @three-ws/avatar three`
- API reference: https://three.ws/docs/web-component

Minimal usage:

    <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
    <agent-3d body="https://three.ws/avatars/default.glb" style="width:400px;height:500px"></agent-3d>
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | README fetched via GitHub API, searched for `three.ws`, `nirholas`, `threews`, `agent-3d` | 0 matches |
| No duplicate suggestion | `gh search prs` / `gh search issues` in the repo for `three.ws` and `nirholas` | 0 results |
| Source link is live | `curl -L` on the `avatar-sdk` tree URL | 200 |
| Loader is live | `curl` on `https://three.ws/agent-3d/latest/agent-3d.js` | 200 |
| API reference is live | `curl` on `https://three.ws/docs/web-component` | 200 |
| Package exists | `npm view @three-ws/avatar` | 0.2.3, Apache-2.0, `repository.directory: avatar-sdk` |
| Install works | `npm install @three-ws/avatar three` in a clean scratch project | succeeded |
| The minimal snippet renders with no key | Headless Chromium loaded the exact snippet above | `agent:ready` fired, no page errors, avatar visible in the screenshot |

The package's main entry references `window`, so it is browser-only; importing it in plain Node
throws. That is expected for a custom element and matches how every other entry in the section
is consumed.

## Target rules complied with

- Format `[Name](Link) - Brief description`, matching the tag-name style the section already uses.
- Description does not start with "A" or "An".
- Added to the relevant category in alphabetical order.
- One addition, useful PR title.
- Searched previous suggestions first (none).

## Owner's single action

Fork the repo, paste the listing line after `<active-table>` in Components, and open the pull
request with the title and body above.
