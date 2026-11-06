# MKT-2026-09-OPENAI-STUDIO: create a real 3D object inside an AI conversation

**Kit status:** copy complete, verified 2026-09-17 with a live keyless generation. Not blocked on
engineering. campaigns.csv status `awaiting_submission`: the Showcase packet and the Developer
Community post are written and unsent.

## At a glance

| Field | Value |
|---|---|
| Campaign id | `MKT-2026-09-OPENAI-STUDIO` |
| Publish date | 2026-09-29 |
| Summary | One sentence in ChatGPT returns a textured, rotatable 3D model with an AR link, from a free keyless MCP connector |
| Audience | AI builders |
| Primary channel | OpenAI Developer Community |
| Secondary channels | X, LinkedIn, Telegram community, three.ws news |
| Proof | https://three.ws/openai |
| Tracked links | X `https://three.ws/openai?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-openai-studio&utm_content=anchor`; LinkedIn `...utm_source=linkedin&utm_medium=social&...&utm_content=post`; Telegram `...utm_source=telegram&utm_medium=community&...&utm_content=announce`; forum `...utm_source=openai-community&utm_medium=community&...&utm_content=forum-post` |
| The single CTA | Try the keyless 3D Studio and share the result |
| Partner ask | Showcase or directory placement and partner-GTM introduction |
| KPI | tool calls and completed generations |

## Audit: what already exists

| Channel | Existing asset | State | How this kit uses it |
|---|---|---|---|
| OpenAI Developer Community (primary) | [docs/openai-community-3d-studio-post.md](../../../docs/openai-community-3d-studio-post.md) | Draft, unposted | **Is** the primary post. Before posting, replace its tool list with the live eleven (see claims check) and add the forum UTM to its first three.ws link |
| X and LinkedIn, partner-status beat | [marketing/openai-select-partner/social-copy.md](../../openai-select-partner/social-copy.md) | Posted beat (Select Partner announcement) | Not reposted. Its wording rules (full "OpenAI Select Partner", no endorsement) govern this kit |
| X, product demo quote post | same file, @nichxbt quote tweet with video | Written | Optional companion from the personal account on the same day |
| Showcase Gallery submission | [prompts/store-submissions/_generated/openai-showcase-submission.md](../../../prompts/store-submissions/_generated/openai-showcase-submission.md) | Ready to paste | Partner ask, part 1 |
| Listing channel map | [docs/openai-listing-channels.md](../../../docs/openai-listing-channels.md) | Current | Source for intake paths |
| Media | [marketing/openai-select-partner/cards](../../openai-select-partner/cards/), `https://three.ws/partners/openai/social-card-studio.png` (200), [partner-packets/images/openai-page.png](../../partner-packets/images/openai-page.png) | Exist | Anchor image: the Studio card |
| X anchor on the Studio mechanism, LinkedIn Studio post, Telegram, news, partner-GTM note | none | Missing | Written below |

## X

**Media:** `https://three.ws/partners/openai/social-card-studio.png` (3200x1800).
**Alt text:** three.ws 3D Studio card: a textured 3D model rendered inline in a ChatGPT conversation,
with the note that the connector is free and keyless.

**Anchor** (174 weighted characters):

```text
Ask ChatGPT for a ceramic robot and a textured 3D model comes back inline: rotate it, rig it, place it in your room. Eleven keyless tools, no account: https://three.ws/openai?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-openai-studio&utm_content=anchor
```

**Thread (optional):**

2/ (154)
```text
The connector is one MCP server at three.ws/api/mcp-studio. No auth header, no key, no wallet. Any MCP client can call the same eleven tools ChatGPT does.
```

3/ (188)
```text
Every result also returns structured content: a GLB URL, a viewer URL, an AR URL, and the concept image it was sculpted from, so a client can render it natively instead of printing a link.
```

4/ (175)
```text
look_at_model renders a GLB from several angles and hands the frames back to the model, so the conversation can judge its own output and call refine_model on what looks wrong.
```

No hashtags on this anchor: it is a product post, not the partner announcement, so the voice contract
applies. No OpenAI account is tagged; no OpenAI X handle is recorded in the repo.

## LinkedIn

```text
A chat assistant can describe a product for as long as you like. Until recently it could not hand you one.

three.ws 3D Studio is a free MCP connector for ChatGPT. Type "a small ceramic robot figurine" and the conversation returns a textured 3D model you can rotate inline, a link that places it in your room in AR, and a downloadable GLB that opens in any 3D tool. The same connector can add a humanoid skeleton, refine a result, and render a model from several angles so the assistant can judge its own output before you do.

It needs no account, no API key, and no payment. It is also a plain MCP server, so any MCP client can call the same eleven tools, and the implementation is open source under Apache-2.0.

three.ws is an OpenAI Select Partner in the OpenAI Partner Network. It is not an OpenAI product and is not endorsed by OpenAI beyond that designation.

Try it and share what you make: https://three.ws/openai?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-openai-studio&utm_content=post
```

(151 words.)

## Telegram community

```text
3D inside ChatGPT, free and keyless.

Connect the three.ws 3D Studio connector and ask for any object. You get a textured model you can rotate right in the chat, an AR link to place it in your room, and the GLB to download. It can rig characters and refine results too.

No account, no key, no payment. Any MCP client works, not only ChatGPT.

Post what you make in the community chat: https://three.ws/openai?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-openai-studio&utm_content=announce
```

## three.ws news blurb

The three.ws 3D Studio connector puts real 3D creation inside a ChatGPT conversation: one sentence
returns a textured model to rotate inline, an AR link, and a downloadable GLB. It exposes eleven
keyless tools over MCP, so any MCP client can use it with no account or key. We also published a
technical write-up of the integration on the OpenAI Developer Community: {{FORUM_POST_URL}}.

## Partner messages

**1. Showcase Gallery:** submit the ready
[Showcase packet](../../../prompts/store-submissions/_generated/openai-showcase-submission.md) at
`https://openai.com/form/showcase-submission` (the form the developers.openai.com showcase page links;
it blocks non-browser clients, so it was not fetched here). The final two attestations need a person
authorized to accept the Showcase Gallery Program Agreement.

**2. Partner-GTM introduction**, sent through the OpenAI Partner Network partner portal (the
authenticated partner record; no named OpenAI contact exists in the repo):

```text
Subject: three.ws (OpenAI Select Partner): a measured 3D Studio story for partner GTM

three.ws 3D Studio is a free, keyless MCP connector that lets ChatGPT create a textured, rotatable 3D model inline, with an AR placement link and a downloadable GLB. We published the build on the OpenAI Developer Community ({{FORUM_POST_URL}}) and submitted the open-source project to the Showcase Gallery on {{SHOWCASE_SUBMITTED_DATE}}.

Seven-day numbers from the launch: {{TOOL_CALLS_7D}} tool calls and {{GENERATIONS_7D}} completed generations.

Two asks: could you introduce us to the partner GTM contact for Select Partners building on the Apps SDK, and confirm that three.ws appears in the Partner Locator? If it is absent, we would like to know what the profile is missing.
```

Send it only after the seven-day numbers exist; do not send it with the fields empty.

## Claims check

| Claim | Proof | Verified |
|---|---|---|
| Eleven tools, keyless, no auth | `tools/list` on `POST https://three.ws/api/mcp-studio` returned 11: `forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`, `check_job`, `create_agent_persona`, `get_agent_persona`, `persona_say`, `look_at_model` | 2026-09-17 |
| A prompt returns a GLB, viewer, AR link, and concept image | live `tools/call forge_free` with "a small ceramic robot figurine": `structuredContent` carried `glbUrl`, `viewerUrl`, `arUrl`, `referenceImageUrl` | 2026-09-17 |
| Renders inline in ChatGPT | Apps SDK widget described in [docs/openai-community-3d-studio-post.md](../../../docs/openai-community-3d-studio-post.md) and [docs/mcp-studio.md](../../../docs/mcp-studio.md) | repo |
| Can rig and refine | `rig_mesh`, `text_to_avatar`, `refine_model` in the live tool list | 2026-09-17 |
| `look_at_model` renders several angles for the model | live tool list; `POST /api/3d/look` returned per-angle frame URLs | 2026-09-17 |
| OpenAI Select Partner, not endorsed | [docs/partners.md](../../../docs/partners.md); `/openai` meta description | 2026-09-17 |
| Apache-2.0 | `gh repo view nirholas/three.ws` license | 2026-09-17 |

Dropped: generation time ("about a minute") because it varies by lane and queue. Drift found: the
community draft names ten tools (no `look_at_model`) while saying eleven; fix before posting.

## Owner does

Post the OpenAI Developer Community draft (with the eleven-tool fix), then publish the X anchor with
the Studio card and submit the Showcase form.
