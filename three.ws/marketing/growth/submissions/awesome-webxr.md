# Awesome WebXR submission

Target: [msub2/awesome-webxr](https://github.com/msub2/awesome-webxr) (283 stars, last push
2026-08-21, one open PR, last merged additions 2026-03-07 and 2025-08-29).

Contribution path: fork, edit `README.md`, open a pull request. Rules live in
[contributing.md](https://github.com/msub2/awesome-webxr/blob/main/contributing.md).

Date verified: **2026-09-17**.

## Product

One product only: **3D AR Studio**, the standalone open-source `<ar-studio>` element
([nirholas/3D-AR-Studio](https://github.com/nirholas/3D-AR-Studio), npm
[`3d-ar-studio`](https://www.npmjs.com/package/3d-ar-studio), live demo
<https://nirholas.github.io/3D-AR-Studio/>). It is the extracted, generalized version of the
three.ws `/ar/studio` surface.

## Why it fits

The list is small and hand-curated for people building WebXR on the web. Its
**Development > Frameworks and Libraries** section lists drop-in libraries (A-Frame, three.js,
Threlte). 3D AR Studio is a library a site adds with one script tag, and its core is real WebXR
work readers of this list care about: `immersive-ar` sessions, one `XRAnchor` per placed model,
hit-test reticle, light estimation, and depth occlusion, with Quick Look and Scene Viewer as the
honest fallbacks where WebXR does not exist.

## Section

`## Development` > `### Frameworks and Libraries`. The section is alphabetical and entries are
separated by a blank line, so the entry goes first, above `A-Frame`.

## Listing line

```markdown
- [3D AR Studio](https://nirholas.github.io/3D-AR-Studio/) - A drop-in `<ar-studio>` web component that places many 3D models in one live camera view using WebXR anchors, hit testing, light estimation, and depth occlusion, with Quick Look and Scene Viewer handoff where WebXR is unavailable. [[repo]](https://github.com/nirholas/3D-AR-Studio)
```

## Pull request title

```text
Add 3D AR Studio to Frameworks and Libraries
```

## Pull request body

```markdown
Adds 3D AR Studio under Development > Frameworks and Libraries.

3D AR Studio is an Apache-2.0 web component for multi-model AR on the web. One script tag gives
a page a camera view where people can place, move, pinch-resize, and rotate any number of GLB
models. On devices with WebXR it runs an `immersive-ar` session with one XRAnchor per model,
light estimation, and depth occlusion; on iOS it hands off to Quick Look and on Android without
WebXR to Scene Viewer. Scenes round-trip through the URL, so a layout composed on desktop
reopens on a phone from a QR code.

- Demo: https://nirholas.github.io/3D-AR-Studio/
- Repo: https://github.com/nirholas/3D-AR-Studio
- npm: https://www.npmjs.com/package/3d-ar-studio

    <script type="module" src="https://unpkg.com/3d-ar-studio/dist/ar-studio.min.js"></script>
    <ar-studio></ar-studio>
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | README fetched via GitHub API, searched for `three.ws`, `nirholas`, `threews`, `agent-3d`, `AR Studio` | 0 matches |
| No duplicate suggestion | `gh search prs` / `gh search issues` for `three.ws` and `nirholas` | 0 results |
| Demo is live | `curl -L https://nirholas.github.io/3D-AR-Studio/` | 200 |
| Repo is public | `gh api repos/nirholas/3D-AR-Studio` | public, Apache-2.0, created 2026-08-19, last push 2026-09-15 |
| Package exists | `npm view 3d-ar-studio` | 0.3.1, Apache-2.0, bins `3d-ar-studio`, `ar-studio`, `3d-ar-studio-mcp` |
| Install works | `npm install 3d-ar-studio` in a clean scratch project | succeeded |
| WebXR anchors, light estimation, depth occlusion, Quick Look, Scene Viewer | Package README ("Why this exists") and the three.ws implementation it was extracted from (`src/ar/multi-place.js`, `src/ar/estimated-lighting.js`, `src/ar/depth-occlusion.js`) | present |

Device AR itself was not exercised on hardware in this pass; the claims above are the shipped
code paths, not a device test.

## Target rules complied with

- Style `[Site](URL) - Description`, matching the neighbouring entries, with the `[[repo]]`
  suffix other entries (XRSH, XR Fragments) use for a separate source link.
- Placed in the most specific existing category, alphabetical position.
- No new category or restructuring.

## Owner's single action

Before opening the PR, load the demo on one Android phone and one iPhone and confirm a model
places. Then fork, paste the entry above `A-Frame`, and open the pull request.
