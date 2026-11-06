# Awesome Generative AI submission

Target: [steven2358/awesome-generative-ai](https://github.com/steven2358/awesome-generative-ai)
(12,645 stars, last push 2026-09-16, additions merged 2026-09-16 and 2026-07-26).

Contribution path: fork, edit the list file, open a pull request. Rules live in
[CONTRIBUTING.md](https://github.com/steven2358/awesome-generative-ai/blob/main/CONTRIBUTING.md).
The maintainer reviews every PR by hand, first in first out (update of 5 Sept. 2026).

Date verified: **2026-09-17**.

## Product

One product only: **AR Forge** at <https://three.ws/ar>, a free, mobile-first page where a text
prompt becomes a 3D model you place in your room with one tap.

## Why it fits

Generative AI that ends in a physical-feeling result is rare on this list, and the list has no
3D generation entry outside developer platforms. AR Forge is the shortest path from a prompt to
a generated object standing in a real room on a phone, with no account.

## Which list

The Main List needs at least 1,000 followers or the maintainer's personal interest; the
three.ws repo has 188 stars, so this PR targets the
[Discoveries list](https://github.com/steven2358/awesome-generative-ai/blob/main/DISCOVERIES.md),
which CONTRIBUTING describes as the showcase for projects below that bar. Section: `## Other`,
added to the bottom (after `DeepDNA`).

## Listing line

```markdown
- [AR Forge](https://three.ws/ar) - Type a prompt, get a textured 3D model, and place it in your room with one-tap AR on any phone. [#opensource](https://github.com/nirholas/three.ws/blob/main/public/ar-forge.html)
```

## Pull request title

```text
Add AR Forge to Other discoveries
```

## Pull request body

```markdown
Adds AR Forge to the Discoveries list under Other.

AR Forge (https://three.ws/ar) is a free text-to-3D page built for phones: type a prompt, the
model is generated on a free lane, and "View in your space" places it in your room through
WebXR, Scene Viewer on Android, or Quick Look on iOS. On desktop it hands off to a phone with a
QR code. No account, no sign-up.

It is open source (Apache-2.0); the page source is linked with the #opensource tag.
```

## Evidence (checked 2026-09-17)

| Claim | Check | Result |
| --- | --- | --- |
| Not already listed | `README.md` and `DISCOVERIES.md` fetched via GitHub API, searched for `three.ws`, `nirholas`, `threews` | 0 matches |
| No duplicate suggestion | `gh search prs` / `gh search issues` for `three.ws` and `nirholas` | 0 results |
| Page is live | `curl -L https://three.ws/ar` | 200 |
| Prompt generation, no account | `POST https://three.ws/api/forge` (the call `public/ar-forge.html` makes) with no credentials | job accepted, `status: queued`, `mode: text_to_3d` |
| AR paths and QR handoff | `data/pages.json` for `/ar` and the AR Forge row in `STRUCTURE.md` | WebXR, Scene Viewer, Quick Look, QR handoff from desktop |
| Open source link is live | `curl -L` on `public/ar-forge.html` in the repo | 200, Apache-2.0 repository |

AR placement itself was not exercised on a phone in this pass; the claims come from the shipped
page and its documented code paths.

## Target rules complied with

- Format `[ProjectName](Link) - Description.` with the `#opensource` tag linked to the source
  because the source lives at a different URL.
- Added to the bottom of its category; description concise and ending in a period.
- Targets Discoveries honestly rather than claiming the Main List follower bar.

## Owner's single action

Try `https://three.ws/ar` once on a phone, then fork, append the entry to Other in
`DISCOVERIES.md`, and open the pull request.
