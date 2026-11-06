# Khronos glTF Project Explorer submission

Target: the Khronos Group's official glTF ecosystem registry, the
[glTF Project Explorer](https://github.khronos.org/glTF-Project-Explorer/), now served through
the [Khronos Ecosystem Explorer](https://ecosystem.khronos.org/khronos-standard/gltf/).

Contribution path: the web form at <https://ecosystem.khronos.org/submit/>. The
[explorer repository README](https://github.com/KhronosGroup/glTF-Project-Explorer) says: "To
submit new projects, go to: https://ecosystem.khronos.org/submit/". The repository itself takes
no content PRs (its last merges were dependency bumps in 2024-05), so do not open a PR there.

Date verified: **2026-09-17**.

## Product

One product only: **three.ws Model Diff**, the structural glTF/GLB diff published as
[`@three-ws/glb-diff`](https://github.com/nirholas/three.ws/tree/main/packages/glb-diff) (library
plus `glb-diff` CLI), with the browser version at <https://three.ws/diff>.

## Why it fits

The explorer is the first stop for people looking for glTF tooling by task. Its data already
has `analyze`, `inspect`, and `validate` tasks, and 329 projects, but nothing that answers "what
changed between two versions of this model". A diff that reports geometry, material, texture,
skeleton, and animation changes with a severity a CI job can gate on is a genuine gap in the
glTF pipeline, and it is built on glTF-Transform, so it reads glTF the way the ecosystem does.

## Category

Map to the explorer's own data vocabulary (read from the live dataset
`public/data/glTF-projects-data.json`):

| Field | Value |
| --- | --- |
| task | `analyze`, `inspect`, `validate` |
| type | `library`, `application`, `web application` |
| language | `JavaScript` |
| license | `Apache-2.0` |
| inputs | `glTF 2.0`, `GLB` |
| outputs | none (it produces text, Markdown, and JSON reports, not models) |

## Form answers

The submission form sits behind a Cloudflare Turnstile challenge, which returned 403 to curl,
WebFetch, and headless Chromium on 2026-09-17, so its exact field labels could not be read. The
answers below cover every field the published dataset stores for a project; fill them into
whichever labels the form shows.

```text
Name:         three.ws Model Diff (glb-diff)
Link:         https://github.com/nirholas/three.ws/tree/main/packages/glb-diff
Description:  Structural diff for glTF 2.0 and GLB files. Reports what changed between two
              versions of a model (geometry, materials, textures, skeletons, animation clips)
              with git-style rename and move detection, and assigns a severity (none, cosmetic,
              minor, major, breaking) that a CI job can fail on. Ships as a JavaScript library,
              a CLI with text, Markdown, and JSON output, and a browser tool at
              https://three.ws/diff that runs locally without uploading the models.
Tasks:        analyze, inspect, validate
Type:         library, application, web application
Language:     JavaScript
License:      Apache-2.0
Inputs:       glTF 2.0, GLB
Outputs:      (leave empty)
Contact:      support@three.ws
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | Live dataset fetched from the repo and searched for `three.ws`, `nirholas`, `glb-diff` | 0 matches |
| No prior request | Issue list of the explorer repo | no three.ws issue |
| Source link is live | `curl -L` on the `packages/glb-diff` tree URL | 200 |
| Browser tool is live | `curl -L https://three.ws/diff` | 200 |
| Package exists | `npm view @three-ws/glb-diff` | 0.1.0, Apache-2.0, bin `glb-diff` |
| Install and CLI work | `npm install @three-ws/glb-diff`, then `npx glb-diff a.glb b.glb` on two copies of `https://three.ws/avatars/default.glb` | "identical: every scene, mesh, material, texture, skeleton and clip matches.", exit 0 |
| Reads JSON glTF as well as GLB | `src/document.js` checks the GLB magic and otherwise parses JSON glTF | present |
| Browser tool does not upload | `/diff` page description in `data/pages.json`: "Runs in your browser, nothing is uploaded." | present |

## Target rules complied with

- Submitted through the channel the explorer README names, not a repo PR.
- Values use the dataset's existing vocabulary, so the entry filters correctly.
- One project per submission.

## Owner's single action

Open <https://ecosystem.khronos.org/submit/> in a normal browser, pass the challenge, and paste
the form answers above.
