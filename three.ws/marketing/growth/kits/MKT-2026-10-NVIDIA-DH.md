# MKT-2026-10-NVIDIA-DH: audio drives a visitor-generated 3D face in the browser

**Kit status:** copy complete. **Blocked: the proof page is broken in production.** On 2026-09-17
`https://three.ws/demos/audio2face` (and `/audio2face`) served its inline module unbundled: it imports
the bare specifier `'three'`, the browser throws `Failed to resolve module specifier "three"`, and the
avatar never leaves "Loading avatar...". The API underneath works (see claims check). Nothing in this
kit posts until the page renders a speaking avatar in a clean browser.

## At a glance

| Field | Value |
|---|---|
| Campaign id | `MKT-2026-10-NVIDIA-DH` |
| Publish date | 2026-10-06 |
| Summary | A typed line is spoken by NVIDIA Magpie, NVIDIA Audio2Face-3D turns that audio into a blendshape track, and the browser maps it onto whatever face the visitor's avatar has |
| Audience | GPU AI and 3D developers |
| Primary channel | NVIDIA Developer Forums |
| Secondary channels | X, LinkedIn, Telegram community, three.ws news |
| Proof | https://three.ws/demos/audio2face |
| Tracked links | X `https://three.ws/demos/audio2face?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-10-nvidia-dh&utm_content=anchor`; LinkedIn `...utm_source=linkedin&utm_medium=social&...&utm_content=post`; Telegram `...utm_source=telegram&utm_medium=community&...&utm_content=announce`; forum `...utm_source=nvidia-forums&utm_medium=community&...&utm_content=forum-post` |
| The single CTA | Run the demo and inspect the implementation |
| Partner ask | Inception reshare and Startup Showcase consideration |
| KPI | demo starts and partner amplification |

## Audit: what already exists

| Channel | Existing asset | State | How this kit uses it |
|---|---|---|---|
| NVIDIA Developer Forums (primary) | [docs/nvidia-forum-browser-digital-human.md](../../../docs/nvidia-forum-browser-digital-human.md) | Draft, unposted | **Is** the primary post. Its latencies are from 2026-09-02; re-measure on posting day |
| X, Audio2Face clip post | [marketing/nvidia-inception/social-copy.md](../../nvidia-inception/social-copy.md) "The Audio2Face clip" | Written, over the 179 target | Replaced by the tighter anchor below; its rules (Inception member wording, `#NVIDIAInception`, `@NVIDIAAIDev`, no coin) govern this kit |
| LinkedIn and Telegram | same file | Membership beat, not the digital-human beat | Not reused for this campaign |
| Partner email | [templates.md, NVIDIA partner amplification note](../templates.md) | Ready | Reused with the two fills below |
| Intake | [docs/nvidia-visibility-map.md](../../../docs/nvidia-visibility-map.md): existing `inceptionprogram@nvidia.com` thread | Current | The only address used |
| Media | [marketing/nvidia-inception/assets/three-ws-audio2face-1920x1080.png](../../nvidia-inception/assets/three-ws-audio2face-1920x1080.png) | Exists | Anchor image, after the page is fixed and the frame re-checked |
| X anchor, LinkedIn and Telegram for this beat, news | none | Missing | Written below |

## X

**Media:** the Audio2Face asset above, or better, a 15-second screen capture of the fixed page with
browser chrome visible. **Alt text:** The three.ws Audio2Face demo: a 3D avatar speaking a typed line,
with live blendshape meters for jaw and mouth moving beside it.

**Anchor** (175 weighted characters):

```text
Type a line and NVIDIA Audio2Face-3D returns 55 blendshapes at 30 fps, mapped onto the face your avatar already has. In a browser tab: https://three.ws/demos/audio2face?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-10-nvidia-dh&utm_content=anchor #NVIDIAInception
```

The one hashtag is a deliberate exception to the voice contract's zero-hashtag rule: the NVIDIA kit
requires `#NVIDIAInception` because it is the tag NVIDIA's social team monitors, and a reshare is this
campaign's partner ask.

**Thread:**

2/ (180)
```text
The loop: Magpie TTS speaks the line, Audio2Face-3D turns that exact audio into a per-frame track, and the browser samples the track against the playing audio's clock. @NVIDIAAIDev
```

3/ (178)
```text
The hard part is the rig. A2F speaks ARKit; many avatars only ship VRM vowels or Oculus visemes. We rebuild each vowel from the ARKit frame, so a five-vowel face still lip-syncs.
```

4/ (123 with the token)
```text
The full write-up, with the resampling trap and measured round trips, is on the NVIDIA Developer Forums: {{FORUM_POST_URL}}
```

## LinkedIn

```text
Audio2Face-3D is usually shown inside a game engine, driving a character somebody built on purpose. We run it in a browser tab, on a character the visitor generated themselves.

Type a line on the three.ws demo. NVIDIA Magpie speaks it, and NVIDIA Audio2Face-3D turns that exact audio into a per-frame track of 55 blendshape weights at 30 frames per second. The browser plays the original audio and samples the track against its clock, so the lips follow the real voice.

The difficult part was never the model. It was the rig: we do not choose the avatar's face. Some ship ARKit shapes, some only VRM vowels or Oculus visemes. Where a face has only vowels, we reconstruct each one from the ARKit frame, so it still lip-syncs.

We wrote up the implementation, including the resampling trap and measured latencies, on the NVIDIA Developer Forums, and the code is open source.

three.ws is a member of NVIDIA Inception. NVIDIA does not endorse three.ws.

Run it: https://three.ws/demos/audio2face?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-10-nvidia-dh&utm_content=post

#NVIDIAInception
```

(172 words.) Tag **NVIDIA for Startups** on LinkedIn, per the NVIDIA kit.

## Telegram community

```text
A talking 3D face, in a browser tab, on NVIDIA models.

Type a line: NVIDIA Magpie speaks it and NVIDIA Audio2Face-3D animates the avatar's face from that exact audio, 30 frames a second. It adapts to whatever face the avatar has, including rigs that only know a few vowel shapes.

Try it, then read how it works on the NVIDIA Developer Forums.
https://three.ws/demos/audio2face?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-10-nvidia-dh&utm_content=announce
```

No coin in this post or thread, per the NVIDIA kit.

## three.ws news blurb

The three.ws Audio2Face demo drives a 3D avatar's face in the browser from NVIDIA Audio2Face-3D: a
typed line is spoken by NVIDIA Magpie, and the returned blendshape track animates the face frame by
frame. It maps onto ARKit, VRM, and Oculus-style rigs without a game engine, and the full implementation
is written up on the NVIDIA Developer Forums: {{FORUM_POST_URL}}.

## Partner message

Use the existing [NVIDIA partner amplification note](../templates.md) in the existing
`inceptionprogram@nvidia.com` thread, with two changes:

1. Replace the demo URL line with the forum post: `We published the implementation on the NVIDIA Developer Forums: {{FORUM_POST_URL}}. The live demo is https://three.ws/demos/audio2face.`
2. Append one sentence: `If the story fits, we would like three.ws considered for the Inception Startup Showcase.`

The visibility map says NVIDIA did not answer the 2026-09-04 Showcase routing question; this reply
continues that thread and does not open a new one.

## Claims check

| Claim | Proof | Verified |
|---|---|---|
| Audio2Face-3D returns 55 blendshape weights at 30 fps | live `POST https://three.ws/api/a2f` with `{"text":"Hello from a browser tab."}`: `fps` 30, `blendShapeNames` length 55, `model` `audio2face-3d` | 2026-09-17 |
| Magpie speaks the line first, one call | same response carries `audio` and `animation`; handler comment in `api/a2f.js` ("One-shot text to speech to animation, server synthesizes via Magpie") | 2026-09-17 |
| Track sampled against the audio clock | [forum draft](../../../docs/nvidia-forum-browser-digital-human.md), "The audio contract"; `src/voice/a2f-player.js` | repo |
| Maps onto ARKit, VRM vowels, Oculus visemes; vowels rebuilt from ARKit | `src/voice/arkit-blendshapes.js`, `src/voice/a2f-player.js` header comment | 2026-09-17 |
| Runs in a browser tab, no engine | **Currently false in production**: the page fails to load `three`. Restore before posting | 2026-09-17 |
| Member of NVIDIA Inception; not a partner, no endorsement | [docs/partners.md](../../../docs/partners.md), [marketing/nvidia-inception/social-copy.md](../../nvidia-inception/social-copy.md) | repo |
| Code is open source | Apache-2.0 per `gh repo view` | 2026-09-17 |

Dropped: the round-trip latencies (measured 2026-09-02 in the draft, not re-measured here; the forum
post carries them after re-measurement) and "a character the visitor generated ninety seconds earlier"
(generation time not re-measured).

## Owner does

Get `/demos/audio2face` rendering again, then post the forum draft and publish the X anchor with the
demo capture.
