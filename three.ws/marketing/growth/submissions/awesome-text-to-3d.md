# Awesome Text-to-3D submission

Target: [yyeboah/Awesome-Text-to-3D](https://github.com/yyeboah/Awesome-Text-to-3D) (602 stars,
last push 2026-09-11, commits on 2026-09-07, 09-09, 09-10 and 09-11). The most actively
maintained text-to-3D list, read by researchers and builders in exactly this space.

Contribution path: fork, edit `README.md`, open a pull request. The repo has no CONTRIBUTING
file; the README carries a "PRs Welcome" badge, and an external product PR (Taxon3D, #150) was
merged on 2026-09-09, which is the precedent this pack follows.

Date verified: **2026-09-17**.

## Product

One product only: **three.ws Forge**, the text, image, or sketch to 3D generator at
<https://three.ws/forge>, with its open-source client
[`@three-ws/forge`](https://github.com/nirholas/three.ws/tree/main/packages/forge).

## Why it fits

The list's **Frameworks & Projects** section holds usable systems next to the papers, including
products (ThreeDee's generators) and live tools (Taxon3D). Forge is a working text-to-3D
product that anyone can try free in a browser, returns a textured GLB, and can auto-rig the
result into an animation-ready humanoid, with its client published as open source.

## Section

`## Frameworks & Projects`. Recent additions sit near the top of the section (Taxon3D, WorldGen,
ThreeDee), so place the entry directly after the ThreeDee entries.

## Listing line

Matches the section's format: title, author, venue and year, then pipe-separated links, with a
blank line between entries.

```markdown
- [three.ws Forge - Text, image, or sketch to a textured, rig-ready 3D GLB](https://three.ws/forge), three.ws, Product 2026 | [code](https://github.com/nirholas/three.ws/tree/main/packages/forge)
```

## Pull request title

```text
Add three.ws Forge to Frameworks & Projects
```

## Pull request body

```markdown
Adds [three.ws Forge](https://three.ws/forge) under Frameworks & Projects.

Forge turns a text prompt, a photo, or a sketch into a watertight, textured GLB in the browser,
with a free generation tier and no account needed to try it. It can also add a humanoid skeleton
to the result so the model is animation-ready. Output downloads as GLB and opens in a shareable
3D viewer.

Code: the client library is open source (Apache-2.0) at
https://github.com/nirholas/three.ws/tree/main/packages/forge (`npm install @three-ws/forge`).

The entry follows the section's existing format (title, author, venue/year, code link), placed
next to the other product entries.
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | README fetched via GitHub API (330 KB), searched for `three.ws`, `nirholas`, `threews` | 0 matches |
| No duplicate suggestion | `gh search prs` / `gh search issues` for `three.ws` and `nirholas` | 0 results |
| Page is live | `curl -L https://three.ws/forge` | 200 |
| Page does what the title says | `data/pages.json` for `/forge`: "Type a prompt, or drop in photos or a sketch, and get a downloadable textured 3D model (GLB)." | present |
| Free lane generates for real | `POST https://three.ws/api/forge {"prompt":"a small ceramic teapot"}` with no credentials | job accepted (`status: queued`, `mode: text_to_3d`); a job on the same free pipeline via the 3D Studio endpoint finished `done` with a public `.glb` |
| Code link is live | `curl -L` on the `packages/forge` tree URL | 200 |
| Package exists | `npm view @three-ws/forge`; `npm install @three-ws/forge` | 0.2.1, Apache-2.0; installs; exports `createForge`, `forge`, `getJob`, `rig`, `catalog` |
| Auto-rigging | `@three-ws/forge` README intro and `rig` export | present |

## Target rules complied with

- Entry mirrors the section's format and link style.
- Code link included, as the section does for every entry with source.
- PR body explains what the project is and why it belongs, as in the merged #150.

## Owner's single action

Fork the repo, paste the entry after the ThreeDee entries in Frameworks & Projects, and open the
pull request.
