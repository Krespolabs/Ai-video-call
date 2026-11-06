# MKT-2026-10-ELEVEN-BODY: a voice agent becomes a speaking, expressive 3D body

**Kit status:** copy complete, verified 2026-09-17. Written to the production reality: **ElevenLabs runs
on three.ws only with a bring-your-own ElevenLabs key.** `GET /api/tts/catalog` reports the ElevenLabs
lane `available: false`, `byok: true`, reason "Add your own ElevenLabs key below", and there is no
platform ElevenLabs account. The grant ask (campaigns.csv status `awaiting_eligibility`) is gated on the
owner confirming headcount under 25.

## At a glance

| Field | Value |
|---|---|
| Campaign id | `MKT-2026-10-ELEVEN-BODY` |
| Publish date | 2026-10-27 |
| Summary | Paste your own ElevenLabs key, give a three.ws agent your voice, and the avatar's mouth moves with the audio on every page it is embedded on |
| Audience | voice AI builders |
| Primary channel | X |
| Secondary channels | LinkedIn, Telegram community, three.ws news |
| Proof | https://three.ws/voice |
| Tracked links | X `https://three.ws/voice?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-10-eleven-body&utm_content=anchor`; LinkedIn `...utm_source=linkedin&utm_medium=social&...&utm_content=post`; Telegram `...utm_source=telegram&utm_medium=community&...&utm_content=announce` |
| The single CTA | Create a voice-enabled agent and share the clip |
| Partner ask | Startup Grant review and Demo Day consideration |
| KPI | voice setup completions and partner response |

## Audit: what already exists

| Channel | Existing asset | State | How this kit uses it |
|---|---|---|---|
| Grant application answers | [marketing/partner-packets/elevenlabs-startup-grants.md](../../partner-packets/elevenlabs-startup-grants.md) | Ready, eligibility unconfirmed | Is the partner message; not duplicated |
| Application core | [templates.md, ElevenLabs Startup Grants application core](../templates.md) | Ready | Superseded by the packet, which corrects it for BYOK |
| Voice Lab doc | [docs/voice-lab.md](../../../docs/voice-lab.md) | Current | Source for BYOK and model claims |
| Media | [partner-packets/images/voice-lab-elevenlabs.png](../../partner-packets/images/voice-lab-elevenlabs.png) | Exists (captured 2026-09-16) | Anchor image |
| X, LinkedIn, Telegram, news | none | Missing | Written below |

## X

**Media:** `marketing/partner-packets/images/voice-lab-elevenlabs.png`; better, a 15-second clip of a
voiced agent speaking on its embed page once recorded.
**Alt text:** The "Use Your Own ElevenLabs Key" section of three.ws Voice Lab, with an API key field and
per-character pricing.

**Anchor** (179 weighted characters):

```text
Bind your ElevenLabs voice to a three.ws agent and every visitor hears it from a 3D body whose mouth moves with the audio. Paste your own key in Voice Lab: https://three.ws/voice?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-10-eleven-body&utm_content=anchor
```

**Thread (optional):**

2/ (155)
```text
The key is used for that one request and never stored. Flash v2.5 is the default model for low latency; Turbo v2.5 and Multilingual v2 are one select away.
```

3/ (144)
```text
Clone your voice from a short recording, bind it to your agent, and the embed speaks to anonymous visitors on your account, rate limited per IP.
```

No ElevenLabs account is tagged: three.ws has no relationship with ElevenLabs (packet wording rule), and
tagging before any response reads as a claim.

## LinkedIn

```text
Most voice agents are a waveform in a corner of the screen. We wanted the voice to have a face.

In three.ws Voice Lab you can paste your own ElevenLabs API key, pick a voice or clone your own from a short recording, and bind it to a 3D agent. From then on the agent speaks in that voice wherever it is embedded, and the avatar's mouth moves with the actual audio rather than a looping talk animation. The calls run on your ElevenLabs account, and the key is used per request and never stored.

Flash v2.5 is the default for low latency, with Turbo v2.5 and Multilingual v2 available. The same agent can be put on any web page with one tag, and the platform is open source.

three.ws integrates the ElevenLabs API; it is not affiliated with or endorsed by ElevenLabs.

Give your agent a voice: https://three.ws/voice?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-10-eleven-body&utm_content=post
```

(154 words.)

## Telegram community

```text
Give your three.ws agent your own voice.

Voice Lab takes your own ElevenLabs API key: pick a voice or clone yours from a short recording, bind it to your agent, and the 3D avatar speaks it with its mouth following the audio, on every page the agent is embedded on. Calls run on your ElevenLabs account; the key is never stored.

Share a clip of your agent talking in the community chat.
https://three.ws/voice?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-10-eleven-body&utm_content=announce
```

## three.ws news blurb

three.ws Voice Lab lets you bring your own ElevenLabs key, clone or choose a voice, and bind it to a 3D
agent, so the avatar speaks in that voice with lip-sync driven by the real audio wherever it is embedded.
Calls run on your own ElevenLabs account and the key is used per request, never stored.

## Partner message

Submit the application in [marketing/partner-packets/elevenlabs-startup-grants.md](../../partner-packets/elevenlabs-startup-grants.md)
at `https://elevenlabs.io/grants-application` (terms checkbox, then the application), from a three.ws
business address, only after confirming headcount under 25. Two adjustments on submission day:

1. Replace its platform stats line with a fresh read of `https://three.ws/api/platform/stats`.
2. Keep its Demo Day ask pointed at a **future** Demo Day: the 2026 edition on 2026-10-21 is already cast.

This campaign's X post goes out whether or not the grant is decided; do not mention the application in
public copy until ElevenLabs accepts it.

## T+7 result fields

| Field | Source |
|---|---|
| Voice setup completions | production logs for `/api/tts/eleven` requests with `x-tts-billing: byok` or `agent_byok` in the window |
| Clones created | `/api/tts/eleven-clone` success count in logs |
| Landing sessions | web analytics, `utm_campaign=mkt-2026-10-eleven-body` |
| Partner response | grant decision email, or "pending" |

## Claims check

| Claim | Proof | Verified |
|---|---|---|
| ElevenLabs lane is bring-your-own-key only | `GET https://three.ws/api/tts/catalog`: `elevenlabs` `available: false`, `byok: true` | 2026-09-17 |
| Key used per request, never stored | [docs/voice-lab.md](../../../docs/voice-lab.md), BYOK section; `x-eleven-key` handling in `api/tts/eleven.js` | 2026-09-17 |
| Agent bound voice speaks to anonymous visitors, rate limited per IP, on the owner's account | `agent_byok` lane in the `api/tts/eleven.js` header comment | 2026-09-17 |
| Clone from a short recording | `api/tts/eleven-clone.js`; [docs/voice-lab.md](../../../docs/voice-lab.md) "Clone" | repo |
| Flash v2.5 default; Turbo v2.5 and Multilingual v2 selectable | `DEFAULT_TTS_MODEL` in `api/_lib/elevenlabs.js`; [docs/voice-lab.md](../../../docs/voice-lab.md) | 2026-09-17 |
| Mouth driven by the real audio | `connectLipSync` in `src/agent-avatar.js` ("viseme morphs are driven from real audio frequency data") | 2026-09-17 |
| No relationship with ElevenLabs | packet "Approved relationship wording" | repo |
| `/voice` is live | HTTP 200 | 2026-09-17 |

Dropped: per-character and per-clone platform prices (they apply to a platform lane that cannot run
today), voice counts, and any usage volume (not measured; BYOK calls bill the user's account).

## Owner does

Publish the X anchor with the Voice Lab image, and confirm headcount so the grant application can go in.
