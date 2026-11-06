# MKT-2026-11-HF-LOOP: an agent inspects and corrects its own 3D output

**Kit status:** copy complete, verified 2026-09-17. The loop is live, but **not in the Space.** The
`three-ws/avatar-viewer` Space is a static viewer (Hugging Face API: `"sdk":"static"`), so nobody can
"reproduce a correction loop" there today. The loop runs through two keyless three.ws endpoints,
`POST /api/3d/look` and `GET /api/sim-readiness`, and the kit sends people to those. The primary post (the
Hugging Face article) is a finished draft awaiting owner approval.

## At a glance

| Field | Value |
|---|---|
| Campaign id | `MKT-2026-11-HF-LOOP` |
| Publish date | 2026-11-03 |
| Summary | Text-to-3D returns a binary an agent cannot read; rendering it back as images, grading it mechanically, and diffing iterations gives the agent a loop instead of a guess |
| Audience | ML and open-source developers |
| Primary channel | Hugging Face Community (article under the `three-ws` org) |
| Secondary channels | X, GitHub Discussions, three.ws news |
| Proof | https://huggingface.co/three-ws |
| Tracked links | X `https://huggingface.co/three-ws?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-hf-loop&utm_content=anchor`; GitHub `...utm_source=github&utm_medium=community&...&utm_content=discussion`; news `...utm_source=three-ws-news&utm_medium=social&...&utm_content=news` |
| The single CTA | Open the Space and reproduce one correction loop (adjusted: open the article and run one look-and-grade call) |
| Partner ask | Community feature or Space GPU grant review |
| KPI | Space sessions, article reads, and partner response |

## Audit: what already exists

| Channel | Existing asset | State | How this kit uses it |
|---|---|---|---|
| Hugging Face article (primary) | [docs/huggingface-agent-feedback-loop.md](../../../docs/huggingface-agent-feedback-loop.md) | Draft; its `/api/3d/look` example was corrected on 2026-09-17 to send `glb_url` | **Is** the primary post, published from `huggingface.co/new-blog` per the [publishing checklist](../../../docs/huggingface.md#publishing-checklist) |
| X thread for the previous article | [marketing/huggingface-article/post.md](../../huggingface-article/post.md) | Posted beat | Pattern and tag rules only (no coin in anything Hugging Face-facing) |
| Media | [kits/images/huggingface-org.png](./images/huggingface-org.png) (captured 2026-09-17) | Exists | Anchor image until the article has its own cover |
| X anchor, GitHub Discussions, news, grant and feature ask | none | Missing | Written below |

**Rule carried from the Hugging Face index:** AI-focused, no coin, exchange, listing, or token content in
the article or in any post that promotes it. This kit has none.

## X

**Media:** `marketing/growth/kits/images/huggingface-org.png`, replaced by a frame of `look_at_model`
output (four angles of one GLB) once captured.
**Alt text:** The three.ws organization page on Hugging Face: two articles, the Avatar Viewer Space, and
the three-ws/avatars model repository.

**Anchor** (167 weighted characters):

```text
A text-to-3D API returns a binary no agent can read. We render the GLB back as images, grade it, diff it, and let the agent retry: https://huggingface.co/three-ws?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-hf-loop&utm_content=anchor @huggingface
```

After the article publishes, swap the link for the article URL with the same UTM parameters.

**Thread (optional):**

2/ (127)
```text
Try the look step with no key: POST a public GLB URL to three.ws/api/3d/look and get one rendered frame per angle back as JSON.
```

3/ (159)
```text
The pieces are on npm under Apache-2.0: @three-ws/see renders, @three-ws/glb-diff compares iterations structurally, @three-ws/retarget drives any humanoid rig.
```

## GitHub Discussions (category: Show and tell)

**Title:** Generate, look, grade, iterate: the feedback loop for agentic 3D, now written up on Hugging Face

```text
We published the third three.ws article on Hugging Face: {{ARTICLE_URL}}

The short version: an agent that generates a GLB cannot perceive it, so it cannot iterate. The loop that fixes that is open and keyless:

1. Look: render the model back into images the agent can see.
   curl -s -X POST https://three.ws/api/3d/look -H 'content-type: application/json' -d '{"glb_url":"https://three.ws/avatars/cesium-man.glb"}'
2. Grade: a mechanical physics-readiness verdict.
   curl -s "https://three.ws/api/sim-readiness?glb_url=https://three.ws/avatars/cesium-man.glb"
3. Diff: @three-ws/glb-diff says whether the last change did anything structural.
4. Retarget: @three-ws/retarget drives any humanoid rig without an allowlist.

Run step 1 or 2 on a model of your own and post what the grade got wrong. Disagreements with the verdict are the most useful replies.
```

## three.ws news blurb

Our third Hugging Face article explains how three.ws closes the feedback loop for agentic 3D: the agent
renders its own GLB back into images, gets a mechanical physics-readiness grade, and diffs each iteration
before it tries again. Both the look and grade steps are free, keyless endpoints anyone can call today.
Read it on Hugging Face: {{ARTICLE_URL}}.

## Partner asks

Hugging Face publishes two self-serve routes; no Hugging Face contact name is in the repo, and neither
route needs one.

1. **Community feature:** publish the article under the `three-ws` organization. Community articles are
   the surface Hugging Face features from; there is no separate feature form, so the ask is the article
   itself plus the replies it earns.
2. **Space GPU grant: hold.** Hugging Face's docs say the community GPU grant application sits in the
   Space's settings (hardware section). The current Space is static and needs no GPU, so applying now
   asks for hardware it would not use. Apply only after the Space is upgraded into the look-and-grade
   loop from the opportunity register, with this justification:

```text
The three.ws feedback-loop Space renders a user's GLB from several angles, grades its physics readiness, and shows the diff between two iterations, so anyone can watch an agentic 3D loop run on their own model. Rendering and grading run server-side today; a GPU would let the Space render in-process and stay responsive under load. The code is Apache-2.0 and the article explaining it is {{ARTICLE_URL}}.
```

## T+7 result fields

| Field | Source |
|---|---|
| Article reads and upvotes | the article page on Hugging Face (upvote count; views where shown) |
| Space sessions | Space analytics in the `three-ws` org settings |
| Look and grade calls | production logs for `/api/3d/look` and `/api/sim-readiness` in the window |
| Landing sessions | web analytics, `utm_campaign=mkt-2026-11-hf-loop` |
| Partner response | feature, comment, grant decision, or "none" |

## Claims check

| Claim | Proof | Verified |
|---|---|---|
| `POST /api/3d/look` is keyless and returns a frame per angle | live call with `glb_url` returned `views[]` each with `image_url` | 2026-09-17 |
| `/api/sim-readiness` is keyless and returns a verdict | live call returned `verdict: "simulation_ready"` with mass, scale, collision fields | 2026-09-17 |
| `@three-ws/see`, `@three-ws/glb-diff`, `@three-ws/retarget` are on npm | `npm view` returned 0.1.0, 0.1.0, 0.1.2 | 2026-09-17 |
| Apache-2.0 | `gh repo view nirholas/three.ws` | 2026-09-17 |
| The org has two articles, one Space, one model | https://huggingface.co/three-ws (capture) and HF API | 2026-09-17 |
| The Space is static | `https://huggingface.co/api/spaces/three-ws/avatar-viewer`: `"sdk":"static"` | 2026-09-17 |
| GPU grant is applied for from Space settings | https://huggingface.co/docs/hub/spaces-gpus, "Community GPU Grants" | 2026-09-17 |

Dropped: "reproduce a correction loop in the Space" (not possible in a static Space) and any follower or
like counts (move daily).

## Owner does

Publish `docs/huggingface-agent-feedback-loop.md` from `huggingface.co/new-blog` under the `three-ws`
organization, then post the X anchor with the article URL.
