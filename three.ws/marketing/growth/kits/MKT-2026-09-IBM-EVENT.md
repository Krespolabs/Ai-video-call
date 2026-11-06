# MKT-2026-09-IBM-EVENT: a user-group event where the 3D world is the venue and the demo

**Kit status:** copy complete, verified 2026-09-17. **Blocked on a date** (campaigns.csv status
`awaiting_date`) and therefore on the IBM Community event page, which is the registration link every
post points at.

## At a glance

| Field | Value |
|---|---|
| Campaign id | `MKT-2026-09-IBM-EVENT` |
| Planned publish date | 2026-09-22, as the T-14 announcement; the event itself runs 14 days later |
| Summary | The second Three.ws User Group session meets inside three.ws: attendees arrive as avatars, talk with spatial voice, and watch an enterprise agent get a rigged 3D body live |
| Audience | enterprise builders and community |
| Primary channel | IBM Community (the user group's event page) |
| Secondary channels | X, Telegram community, three.ws news |
| Proof | https://three.ws/play |
| Tracked link, IBM event page | `https://three.ws/play?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-09-ibm-event&utm_content=event-page` |
| Tracked link, X | `https://three.ws/play?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t-1` |
| Tracked link, Telegram | `https://three.ws/play?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=announce` |
| The single CTA | Register and bring an avatar or build to show |
| Partner ask | Provide one product speaker and amplify the IBM event page |
| KPI | registrations and live attendees |

`{{IBM_EVENT_URL}}` below is the event page URL IBM Community generates when the event is created in
the group. The X anchor links it (registration is the CTA); an IBM-domain URL carries no UTM.

## Audit: what already exists

| Channel | Existing asset | State | How this kit uses it |
|---|---|---|---|
| Event format and costing | [docs/ibm-next-event.md](../../../docs/ibm-next-event.md) | Proposal (recommends a week-long Forge-Off Open) | This campaign is the one-hour in-world session from the [opportunity register](../opportunities.md) ("Give an enterprise agent a 3D body, live"). If the owner picks the Forge-Off Open instead, keep this kit's channels and swap the run of show |
| Partner relationship note (speaker, calendar listing, June follow-ups) | [templates.md, IBM relationship note](../templates.md) | Ready | Sent first, unchanged |
| First meetup X copy | [docs/x-posts/event-x-posts.md](../../../docs/x-posts/event-x-posts.md), [x-meetup-posts.md](../../../docs/x-posts/x-meetup-posts.md) | Posted in August | Pattern only (IBM first, absolute clock time, never "in N hours"). Its Granite and payment claims are **not** reused: production has no `WATSONX_*` credentials |
| First meetup blog (IBM Community) | [docs/ibm-community-blog-meetup-jessica.md](../../../docs/ibm-community-blog-meetup-jessica.md) | Published | Linked from the event page as the precedent |
| Event page copy, X anchor for event two, Telegram, news, amplification ask, clip script, T-1, run of show, recap | none | Missing | Written below |

## IBM Community event page (primary channel)

**Title:** Three.ws User Group, session two: give an enterprise agent a 3D body, live

**Description:**

```text
Most user groups meet on a video call. This one meets inside the product.

Open three.ws/play in a browser and you arrive as a 3D avatar in a shared world. Walk up to someone and you hear them through spatial voice. Nothing to install, no account needed to look around.

In one hour:
1. Live build: a one-sentence prompt becomes a rigged 3D avatar, and one <agent-3d> tag puts it on a blank web page.
2. Guest segment: {{SPEAKER_NAME}}, {{SPEAKER_ROLE}}, on {{SPEAKER_TOPIC}}.
3. Community showcase: bring an avatar or a build and show it to the room.
4. Open Q&A. The skeptical questions are the most useful ones.

When: {{EVENT_TIME_UTC}}
Where: https://three.ws/play?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-09-ibm-event&utm_content=event-page
Before you come: make your avatar at https://three.ws/create so you arrive as yourself.

How the first in-world meetup went: see the group blog post "The First Three.ws User Group Meetup: How It Actually Went".

three.ws is an IBM Business Partner. This is a community event hosted by three.ws in the Three.ws User Group; it is not an IBM product event.
```

If no IBM speaker is confirmed by T-7, delete item 2 and renumber; never list an unconfirmed name.

## X

**Media:** [docs/media/meetup-banner-x.png](../../../docs/media/meetup-banner-x.png) until a fresh
in-world capture exists (headless capture of `/play` crashed on 2026-09-17; record the world in a real
browser for the T-7 clip and pull a still from it). No IBM mark on any image.
**Alt text:** Avatars gathered in the three.ws plaza for a Three.ws User Group meetup.

**Anchor, T-14** (171 weighted characters, measured with a placeholder IBM URL):

```text
The Three.ws User Group on IBM Community meets inside a live 3D world. Make an avatar from one sentence, walk in, and show the room what you built: {{IBM_EVENT_URL}}
```

**Thread (optional):**

2/
```text
The hour: a prompt becomes a rigged avatar and goes onto a blank page with one tag, then a community showcase, then open Q&A. Spatial voice, so you hear people from where they stand.
```

3/
```text
The first in-world meetup ran in August. The world is open to anyone with the link, so bring a friend who has never heard of a user group. Time: {{EVENT_TIME_UTC}}
```

No `@IBM` tag: the voice rule is to tag IBM when the thing runs on watsonx, and Granite is not running
in production today.

## Telegram community

```text
The Three.ws User Group on IBM Community meets again, and again it meets inside three.ws.

{{EVENT_TIME_UTC}}. Open the world in a browser, arrive as your avatar, and talk with spatial voice. We build an agent's 3D body live, then hand the floor to the community: bring an avatar or a build to show.

Register on IBM Community: {{IBM_EVENT_URL}}
Make your avatar first: https://three.ws/create?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=announce
```

## three.ws news blurb

The Three.ws User Group on IBM Community holds its second session on {{EVENT_TIME_UTC}}, inside the
three.ws world rather than on a call. Attendees arrive as avatars, watch an agent get a rigged 3D body
built live, and show their own builds to the room. Registration is on the group's IBM Community event
page.

## Partner messages

**1. Speaker and calendar listing:** send the existing
[IBM relationship note](../templates.md) unchanged, in the existing thread with the IBM marketing
contact from the 2026-06-15 and 2026-06-18 meetings (intake named in
[docs/ibm-visibility-map.md](../../../docs/ibm-visibility-map.md), Tier 1 rows 3 and 4). Send the Agent
Connect `APP_ID` request separately, as the template says.

**2. Amplification, the day the event page is live (same thread):**

```text
Subject: Three.ws User Group session two is live on IBM Community

The event page is up: {{IBM_EVENT_URL}}

It runs {{EVENT_TIME_UTC}} inside the three.ws world, the same format as the August meetup: attendees arrive as avatars, a live build, a community showcase, and Q&A.

One ask: could the IBM Community team feature the event on the community calendar or newsletter, and could an IBM social account repost our announcement ({{X_POST_URL}})? Attached: a 16:9 image, a 20-second clip of the world, and alt text for both. We will send the recap with attendance and replay within 24 hours of the session.
```

Contact names are not in the repo; address it to the existing thread, do not guess a name.

## Event package

`{{EVENT_TIME_UTC}}` is the confirmed start written as `YYYY-MM-DD HH:MM UTC`; add one US Pacific and
one US Eastern time beside it on the event page. It is filled when the owner confirms the date, then
the in-world schedule is set with `npm run event:schedule -- --start <ISO> --duration 60 --apply`
(writes `public/event.json`; it needs a deploy to go live, which is owner-gated).

**T-7 demo clip, 20 seconds:**

| Time | Shot | Route |
|---|---|---|
| 0:00 to 0:05 | Type one sentence; the avatar generates | https://three.ws/create |
| 0:05 to 0:10 | The rigged avatar idles and walks | https://three.ws/create result |
| 0:10 to 0:16 | Walk into the world as that avatar; other avatars in frame | https://three.ws/play |
| 0:16 to 0:20 | End card: "Three.ws User Group, {{EVENT_TIME_UTC}}, register on IBM Community" | card |

**T-1 reminder** (197 weighted characters with the token in place):

```text
Tomorrow at {{EVENT_TIME_UTC}}: the Three.ws User Group meets inside three.ws. Open the world in a browser, arrive as your avatar, talk with spatial voice. Free, no install: https://three.ws/play?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t-1
```

**Live run of show (60 minutes):**

| Minute | Segment | Owner |
|---|---|---|
| T-30 | Doors open in the world; host in the plaza; moderator checks spatial voice | Host, moderator |
| 0 to 5 | Welcome, house rules, where Q&A goes | Host |
| 5 to 20 | Live build: prompt to rigged avatar at `/create`, then one `<agent-3d>` tag on a blank page | Host |
| 20 to 35 | Guest segment (only if confirmed) | IBM speaker |
| 35 to 50 | Community showcase: attendees walk up and present | Moderator calls names |
| 50 to 60 | Q&A, next date, where the recap will be posted | Host |

Fallback: a pre-generated avatar staged in case a generation worker is slow; the build segment never
waits on a live queue.

**T+1 recap skeleton:**

```text
Three.ws User Group, session two: the recap.

Registered: {{REGISTRATIONS}}
Peak avatars in the world: {{PEAK_CONCURRENCY}}
Built live: {{BUILD_RESULT_URL}}
Showcased by the community: {{SHOWCASE_LINKS}}
Replay: {{REPLAY_URL}}
Next session: {{NEXT_EVENT_URL}}
```

| Field | Source |
|---|---|
| `{{REGISTRATIONS}}` | IBM Community event page registrant count (group admin view) |
| `{{PEAK_CONCURRENCY}}` | multiplayer server presence during the window (Cloud Run logs for `three-ws-multiplayer`); the first-meetup recap used the same measure |
| `{{BUILD_RESULT_URL}}` | the avatar page generated in the build segment |
| `{{SHOWCASE_LINKS}}` | links the presenters shared in chat |
| `{{REPLAY_URL}}` | the uploaded recording |
| `{{NEXT_EVENT_URL}}` | next event page, or omit the line |
| Landing sessions (scorecard only) | web analytics, `utm_campaign=mkt-2026-09-ibm-event` |

## Claims check

| Claim | Proof | Verified |
|---|---|---|
| Three.ws User Group exists on IBM Community and we moderate it | group page returns 200; [docs/partners/opportunities.md](../../../docs/partners/opportunities.md) "Live and working" | 2026-09-17 |
| A first in-world meetup already ran | [docs/ibm-community.md](../../../docs/ibm-community.md), blog posts 3 and 4 | repo |
| `/play` is a live shared 3D world | https://three.ws/play returns 200 | 2026-09-17 |
| Spatial voice | `multiplayer/src/rooms/WalkRoom.js` voice signaling (`voice-state`, `voice-signal`) | 2026-09-17 |
| One sentence to rigged avatar at `/create` | [docs/ibm-next-event.md](../../../docs/ibm-next-event.md) capability table; `/create` returns 200 | 2026-09-17 |
| No account needed to look around | `/play` welcome dialog text ("look around with no wallet") in `marketing/the-first-19-weeks/images/play.png` | repo |
| three.ws is an IBM Business Partner | [docs/partners.md](../../../docs/partners.md) | repo |
| No event currently scheduled in-world | https://three.ws/event.json returns the no-event state | 2026-09-17 |

Dropped: "agents think on IBM Granite" (`/api/ibm/galaxy` returns `watsonx_not_configured` on
2026-09-17), attendance numbers from the first meetup (not needed for the ask), and the commemorative
wearable (only true if a souvenir id is set in `public/event.json` for this event; add it back only then).

## Owner does

Pick the date, send the IBM relationship note in the existing thread, and create the event in the
Three.ws User Group with the description above.
