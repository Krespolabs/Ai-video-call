# IBM Community event two: the complete kit

**Campaign:** `MKT-2026-09-IBM-EVENT` in [campaigns.csv](../campaigns.csv) (the ID stays as
written even though the session lands in October; [measurement.md](../measurement.md) forbids
renaming a campaign). **Venue:** the Three.ws User Group on IBM Community, held inside the
`$THREE` home town at `three.ws/play`. **Package:** the T-21 to T+7 event package in the
[command center](../README.md#3-the-community-becomes-the-stage).

Everything below is paste-ready. The owner's work is: pick one of the three dates, send the two
emails, create the IBM Community event, deploy the event config, and press post on each beat.
The ordered checklist is in [Owner steps](#owner-steps-in-order).

Read [the event proposal](../../../docs/ibm-next-event.md) for why this format, and
[badge-usage.md](../../ibm-partner-plus/badge-usage.md) before editing any IBM-facing sentence.

---

## Decisions already made (reverse any in one line)

| Decision | Choice | Why | Alternative |
|---|---|---|---|
| Format | 60-minute live session inside `/play`: live build, forge-into-the-world, IBM guest segment, an agent paying for a tool, community showcase | Every segment runs on a shipped, verified surface (see [Feature verification](#feature-verification)). The Forge-Off Open in the proposal is a week-long program and a bigger ask; this session is its natural kickoff | Run the Forge-Off Open as event two and use this run of show as its Day 0 |
| Recommended date | **Thursday 2026-10-15, 16:00 to 17:00 UTC** | Thursday is the live-demo day in the [weekly rhythm](../README.md#weekly-operating-rhythm). T-21 falls on 2026-09-24, which leaves IBM four weeks to list and staff it | The two alternates below |
| Time | 16:00 UTC | 12:00 PM Eastern, 9:00 AM Pacific, 5:00 PM London (BST): the one hour that is daytime for both US coasts and Europe | 17:00 UTC matches the first meetup's slot |
| Souvenir | Optional, new item | The Meetup Laurel is promised as never granted again, so it must not be reused | Run without a drop |
| Granite demo | **Not live on stage** | Production has no `WATSONX_*` credentials: `GET https://three.ws/api/ibm/galaxy` answers `watsonx_not_configured` (checked 2026-09-17). The IBM segment is IBM's to fill | Restore the credentials first, then add a Granite beat |

### The three candidate dates

All three are Thursdays in October 2026. US daylight saving time ends 2026-11-01, so every
October date is on Eastern Daylight Time (UTC-4).

| Option | Date | UTC | US Eastern | T-21 | T-14 | T-7 | T-1 | T+1 | T+7 | Calendar notes |
|---|---|---|---|---|---|---|---|---|---|---|
| **A (recommended)** | Thursday, October 15, 2026 | 16:00 to 17:00 | 12:00 to 1:00 PM EDT | Sep 24 | Oct 1 | Oct 8 | Oct 14 | Oct 16 | Oct 22 | Same week as the Oct 13 anchor campaign; no Thursday conflict |
| B | Thursday, October 22, 2026 | 16:00 to 17:00 | 12:00 to 1:00 PM EDT | Oct 1 | Oct 8 | Oct 15 | Oct 21 | Oct 23 | Oct 29 | Same week as the Oct 20 AWS anchor |
| C | Thursday, October 29, 2026 | 16:00 to 17:00 | 12:00 to 1:00 PM EDT | Oct 8 | Oct 15 | Oct 22 | Oct 28 | Oct 30 | Nov 5 | Day before the Oct 30 "live world access" utility post, which can then point at the replay; UK is back on GMT, so London is 4:00 PM |

**The copy below is written for Option A.** If B or C is booked, apply this find-and-replace
across the kit before posting, and nothing else changes (agenda beats are minutes after the
start, so they move with it). It applies to sections 1, 4, 5 and 6 only: the two emails in
sections 2 and 3 go out before a date is booked and already name all three options.

| Find (Option A) | Replace for B | Replace for C |
|---|---|---|
| `Thursday, October 15, 2026` | `Thursday, October 22, 2026` | `Thursday, October 29, 2026` |
| `Thu Oct 15` | `Thu Oct 22` | `Thu Oct 29` |
| `October 15` | `October 22` | `October 29` |
| `2026-10-15T16:00:00Z` | `2026-10-22T16:00:00Z` | `2026-10-29T16:00:00Z` |
| `2026-10-15T17:00:00Z` | `2026-10-22T17:00:00Z` | `2026-10-29T17:00:00Z` |
| `5:00 PM London` | `5:00 PM London` | `4:00 PM London` |
| `6:00 PM Berlin` | `6:00 PM Berlin` | `5:00 PM Berlin` |
| `tomorrow` (T-1 posts, sent Oct 14) | sent Oct 21 | sent Oct 28 |

---

## 1. IBM Community event page

Create it from the group's [events page](https://community.ibm.com/community/user/groups/community-home/recent-community-events?communitykey=e71510cc-d953-408f-9a1c-019f5c0a7016)
(or send this section to the IBM community manager if IBM creates it). The first meetup's page,
[ibm-community-meetup-play.html](../../../docs/ibm-community-meetup-play.html), is the format
reference.

**Event image:** do not reuse the first meetup's banner (its date is baked in) and do not place
the IBM 8-bar on a new one: [badge-usage.md](../../ibm-partner-plus/badge-usage.md) says the mark
comes only from IBM's partner portal under IBM's terms. Use a `/play` photo-mode card captured at
rehearsal (see [Pre-flight](#pre-flight-and-rehearsal)); it is stamped with the event name.

### Title

```text
Give an Agent a Body, Live: Three.ws User Group Session Inside the 3D World
```

### Abstract

```text
Most AI agents still live in a text box. In this session the Three.ws User Group meets inside
a live 3D world instead of on a call, and builds the alternative in front of you: a rigged,
animated agent generated from a single sentence, walking around the same world you are
standing in.

You join from your browser as an avatar. No download, no install, no account. Walk up to
people to talk with spatial voice, or use text chat. In one hour you will watch a text prompt
become a rigged 3D agent and put it on, forge a 3D object from a sentence and see it appear in
the world for everyone, hear from a guest from IBM, and watch two AI agents complete a real
pay-per-call transaction on screen, with a public on-chain receipt.

Hosted by three.ws in the Three.ws User Group on IBM Community. three.ws is an IBM Business
Partner. IBM does not endorse three.ws, and three.ws is not an IBM product.
```

### Agenda

```text
12:00 PM ET  Doors open in the plaza. Welcome, and how to move, talk, and emote.
12:06 PM ET  Live build: one sentence to a rigged, animated 3D agent, then we wear it.
12:15 PM ET  Forge into the world: type a sentence in chat, place the 3D object for everyone.
12:22 PM ET  Guest segment: [IBM SPEAKER: name, title, and topic, supplied and approved by IBM]
12:37 PM ET  An agent pays for a tool: two agents settle a real micropayment, receipt on screen.
12:42 PM ET  Community showcase: members show the avatars and builds they brought.
12:50 PM ET  Open Q&A. The skeptical questions are the useful ones.
12:57 PM ET  Group photo, and the date of the next session.
```

### Event details table

```text
When:          Thursday, October 15, 2026, 12:00 to 1:00 PM Eastern (16:00 to 17:00 UTC)
Your time:     9:00 AM San Francisco, 12:00 PM New York, 5:00 PM London, 6:00 PM Berlin
Where:         https://three.ws/event (countdown, add-to-calendar, and the door into the world)
Cost:          Free
What you need: A modern desktop or laptop browser. No download, no install, no account.
Optional:      Make your own avatar beforehand at https://three.ws/create and bring it.
```

### Login instructions field

```text
No account or login is required. At the event time open https://three.ws/event and press the
button into the world, or open https://three.ws/play and choose the pinned $THREE world. You
enter as a guest with an avatar assigned automatically. Press V in the world to change it,
including to one you made at https://three.ws/create.

Voice is spatial: your browser asks for microphone permission like any web call. Allow it to
talk, or decline and use text chat (press Enter). First time in a 3D world? A short controls
guide opens on your first visit, and the team is at the spawn point from 11:45 AM ET.
```

### Speaker slot (for IBM to fill)

| Field | Value |
|---|---|
| Segment | 12:22 to 12:37 PM ET, 15 minutes including 3 minutes of questions |
| Speaker | [IBM SPEAKER: name and title, supplied by IBM] |
| Topic | [IBM SPEAKER TOPIC: chosen by IBM. Suggested fit: governing AI agents in production, or listing agent tools for enterprise catalogs] |
| Format | Speaker joins the world as an avatar and talks over spatial voice from the plaza, or shares slides in the stream and is shown on the host's screen. Rehearsal slot offered on T-2 |
| Approval | IBM approves this segment's title, the speaker's name and title, and every sentence that describes IBM's role before the page goes live |

### Registration CTA

For the IBM Community page's register button and the closing line of every post:

```text
Register on IBM Community to get the reminder, then add it to your calendar at three.ws/event.
```

---

## 2. Relationship email to IBM

**To:** the IBM marketing contact from the 2026-06-18 meetings, as a reply on that existing
thread (the contacts are in the owner's inbox; no address is recorded in this repo, so none is
written here). **From:** nich@three.ws. **Send by:** T-21 (Sep 24 for Option A); the
[opportunity register](../opportunities.md) schedules it for 2026-09-18. **One ask per
paragraph, one thread.** The Agent Connect request goes separately (section 3).

Subject:

```text
Three.ws User Group: event two in October, the three.ws page, co-promotion, and Partner Plus marketing access
```

Body:

```text
Hi [IBM CONTACT FIRST NAME],

Following up on our June 18 conversations with a concrete next step, and four small asks.

1. Event two. We are ready to run the second Three.ws User Group session, again inside the
three.ws 3D world rather than on a call: a live build of a rigged 3D agent from one sentence,
an object forged into the world by the audience, two agents completing a real pay-per-call
transaction on screen, and a community showcase. We hold three dates, all Thursdays at 12:00
PM Eastern (16:00 UTC): October 15, October 22, or October 29. We would like to confirm one by
[DATE: T-21 of the earliest option you can support].

We provide the venue, the event page copy, moderation, rehearsal, the recording, visual assets,
and a recap within 24 hours. Could IBM help with one 15-minute speaker segment (topic is yours;
agent governance or enterprise agent catalogs would fit the audience) and a listing on the IBM
Community events calendar? The full event page copy is ready to send.

2. The dedicated three.ws page on the IBM domain discussed in June. Is there a next step or a
draft we can review? We can supply copy, architecture notes, and assets in whatever format
your team uses.

3. IBM social co-promotion. Once the event date is set, would IBM's social team share the
event page, and the recap afterwards? We will send the post copy, alt text, and a 16:9 image at
least 48 hours ahead.

4. Partner Plus marketing access. As a Build track partner, could you enable our access to My
Digital Marketing and the Build track Partner Marketing Kit? We would use it for this event
series first.

Jessica's recap of the first in-world meetup is on the group blog:
https://community.ibm.com/community/user/blogs/jessica-swanson/2026/08/08/the-first-threews-user-group-meetup-ibm

Thank you,
Nich
three.ws
```

Before sending: replace the two bracketed values, and confirm that nothing in the body says IBM
endorses, co-hosts, or partners on the event (it does not as written).

---

## 3. Agent Connect `APP_ID` request (separate email)

**To:** `IBMAgentConnect@ibm.com`, the program inbox documented in
[agent-connect-listing.md](../../ibm-partner-plus/agent-connect-listing.md#step-0-the-one-blocking-email).
That file's Step 0 is the source of truth; this is the same email, repeated here so the kit is
self-contained. Allow 2 to 3 business days. Save the `APP_ID` from the reply, then the listing is
a transcription job from that file into IBM Concierge.

Subject:

```text
MCP APP_ID Request - three.ws
```

Body:

```text
Company name: three.ws
MCP server name: three.ws 3d studio
Submission type: BYOL

Brief description: A remote MCP server that turns text prompts, images, and video into
textured, rigged, animation-ready 3D models and returns them as inline interactive
artifacts. Also performs remeshing, retexturing, segmentation, optimisation, and
automatic rigging on existing models.

We are an existing IBM Business Partner. three.ws agents can run on IBM Granite foundation
models served through IBM watsonx.ai.
```

The last sentence previously said Granite runs "in production". That is not true while the
production service has no watsonx credentials, so both copies now use the safe claim from
[badge-usage.md](../../ibm-partner-plus/badge-usage.md#the-claims-ranked-from-safe-to-forbidden).

---

## 4. Posts

**Rules that apply to every post:** no hashtags, no emoji, no em or en dashes; one link; every X
post carries an image (voice rule 1 in [announce-voice.md](../../../docs/announce-voice.md)).
Do not tag `@IBM` (Granite is not serving, so voice rule 4 does not hold) and do not name the
IBM speaker until IBM has approved the wording. Check each X post before sending with
`node scripts/post-tweet.mjs --text "<post>" --dry-run`, which prints the weighted count.

**Images:** T-14 and T-1 use the rehearsal photo-mode card; T-7 uses a 20-second screen
recording of `/forge` in chat placing an object in the plaza; Live uses a live photo-mode card;
T+1 uses the replay clip; T+7 uses the group photo.

**Links:** every link is `https://three.ws/event` with UTMs per
[measurement.md](../measurement.md). The channel values are listed once here so the posts stay
readable:

| Channel | Link |
|---|---|
| X | `https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=<beat>` |
| LinkedIn | `https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=<beat>` |
| Telegram | `https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=<beat>` |
| IBM Community | `https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-09-ibm-event&utm_content=<beat>` |

`<beat>` is `t14`, `t7`, `t1`, `live`, `t1-recap`, or `t7-proof`. The posts below show the X
link fully resolved; swap `utm_source`/`utm_medium` for the other channels.

### T-14 (Oct 1): announce and open registration

X:

```text
The next IBM Community user group session meets inside a 3D world, not a call: one sentence becomes a rigged agent live. Thu Oct 15, 16:00 UTC, no account. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t14
```

LinkedIn:

```text
Most AI agents still live in a text box. On Thursday, October 15, the Three.ws User Group on IBM Community meets somewhere else: inside a live 3D world, in the browser, as avatars.

In one hour:
- one sentence becomes a rigged, animated 3D agent, live, and we walk around in it
- the audience forges 3D objects from chat and places them in the world for everyone
- a guest segment for the IBM Community audience
- two AI agents complete a real pay-per-call transaction on screen, with a public on-chain receipt
- a community showcase and open Q&A

12:00 PM Eastern / 16:00 UTC. Free. No download, no install, no account.

Register on IBM Community for the reminder, and add it to your calendar here:
https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t14

three.ws is an IBM Business Partner. IBM does not endorse three.ws, and three.ws is not an IBM product.
```

Telegram (community group and the release channel):

```text
Next community session: Thursday, October 15, 16:00 UTC (12:00 PM Eastern), inside the $THREE home town on three.ws/play, hosted in our IBM Community user group.

Live build of a rigged agent from one sentence, forge objects into the plaza together, a guest segment, and two agents paying each other on screen with a Solana receipt. Then your showcase: bring an avatar or a build and we put you on stream.

Countdown and add-to-calendar: https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=t14
```

IBM Community (new discussion thread in the group, linking the event listing):

```text
Title: October 15: Give an Agent a Body, Live (Three.ws User Group session two)

The second Three.ws User Group session is on the calendar: Thursday, October 15, 12:00 to 1:00 PM Eastern (16:00 UTC). Like the first meetup, it happens inside the three.ws 3D world in your browser rather than on a call.

What we will do in the hour:
1. Build a rigged, animated 3D agent from a single sentence, live, and wear it in the world.
2. Forge 3D objects from chat and place them in the plaza, audience included.
3. A guest segment for this community.
4. Watch two AI agents complete a pay-per-call transaction on screen, with a public receipt.
5. A member showcase, then open Q&A.

How to join: open https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-09-ibm-event&utm_content=t14 at the start time. No download, no install, no account.

Want a showcase slot? Reply here with what you will bring (an avatar, a build, an agent) and we will reserve up to three.

Please register on the event listing in the group's Events tab so you get the reminder.
```

### T-7 (Oct 8): demo clip and community challenge

X:

```text
Type /forge and a sentence into the world chat and the 3D object lands in the plaza for everyone. Forge one before Oct 15; the best go on stream. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t7
```

LinkedIn:

```text
A one-week challenge before our October 15 session.

In three.ws/play, type /forge followed by a sentence into chat. The platform generates a textured 3D model from it and hands it back into the world, where one click places it for every player present. It persists, so the plaza keeps what the community builds.

Forge something before Thursday, October 15, take a photo with P (photo mode stamps the world and the date), and share it. The best three go on stream during the session's community showcase.

Countdown and calendar: https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t7
```

Telegram:

```text
One week to the October 15 session. Challenge: forge something into the plaza before then.

In three.ws/play, press Enter and type /forge followed by what you want, for example /forge a stone bench with brass fish. Click to place it when it lands. Press P for a photo and post it here. The best three are shown on stream on Thursday, October 15.

https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=t7
```

IBM Community (reply in the T-14 thread, not a new thread):

```text
One week out. A small warm-up for anyone who wants to try the world before Thursday, October 15: open three.ws/play, press Enter to open chat, and type /forge followed by a short description of one object. It is generated as a real 3D model and placed into the shared world for everyone. Post a photo (press P) in this thread and we will show the best three during the showcase.

https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-09-ibm-event&utm_content=t7
```

### T-1 (Oct 14): reminder with exact times

X:

```text
Tomorrow the IBM Community user group meets inside the three.ws world: 16:00 UTC, 12:00 PM Eastern. Any browser, no account, no download. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t1
```

LinkedIn:

```text
Tomorrow, Thursday, October 15: the Three.ws User Group session inside the 3D world.

16:00 UTC / 12:00 PM Eastern / 9:00 AM Pacific / 5:00 PM London. One hour. Open the link in a desktop browser at the start time and you walk in as an avatar. The team is at the spawn point 15 minutes early for anyone new to 3D worlds.

https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t1
```

Telegram:

```text
Tomorrow: 16:00 UTC (12:00 PM Eastern, 9:00 AM Pacific, 5:00 PM London). The countdown chip goes gold in the plaza 30 minutes before, and we are at spawn 15 minutes early. Bring your forged objects and your avatar.

https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=t1
```

IBM Community (reply in the T-14 thread):

```text
Reminder: tomorrow, Thursday, October 15, 12:00 to 1:00 PM Eastern (16:00 UTC). Open https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-09-ibm-event&utm_content=t1 in a desktop browser at the start time. We are at the spawn point from 11:45 AM Eastern to help anyone get moving and talking.
```

### Live (Oct 15, post at 12:00 PM ET)

X:

```text
Live now: the IBM Community user group session inside the three.ws world. Walk in from any browser, no account, and you are in the plaza in under a minute. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=live
```

LinkedIn:

```text
We are live inside the three.ws world for the Three.ws User Group session. Open the link in a desktop browser and you join the plaza as an avatar, no account needed. The live build starts at 12:06 PM Eastern.

https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=live
```

Telegram:

```text
LIVE now in the $THREE home town. Doors are open, the live build starts in six minutes. Walk in: https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=live
```

IBM Community (reply in the T-14 thread):

```text
We are live. Join here: https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-09-ibm-event&utm_content=live
```

### T+1 (Oct 16): replay, links, next date

Fill the bracketed counts only from the [measurement](#measurement) capture. Never estimate.
If a count was not captured, delete its sentence.

X:

```text
Replay: one sentence became a rigged agent, the audience forged objects into the plaza, and two agents settled a payment on stream. Next: Tue Nov 24. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t1-recap
```

LinkedIn:

```text
Yesterday's Three.ws User Group session, recapped in one clip.

What happened in the hour, in order: a single sentence became a rigged, animated agent, and the host walked around the plaza in it. Attendees forged 3D objects from chat and placed them in the shared world. [IBM SEGMENT SUMMARY: one sentence, approved by the IBM speaker]. Two AI agents completed a real pay-per-call transaction on screen, and the receipt is public on Solana: [EXPLORER URL FROM THE LIVE ROUND]. Members showed what they brought.

[ATTENDANCE SENTENCE, only from the captured peak count, for example: "[N] people were in the world at the peak."]

The next session is Tuesday, November 24: an agent buys a tool and comes back with a result you can verify.

https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t1-recap
```

Telegram:

```text
Thank you to everyone who came into the world yesterday. The replay clip is above. Everything you forged into the plaza is still standing, so go find it. Next session: Tuesday, November 24, 17:00 UTC.

https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-09-ibm-event&utm_content=t1-recap
```

IBM Community (group blog post, the recap owed within 24 hours; draft it in
`docs/ibm-community-blog-session-2-recap.md` from the capture, then paste):

```text
Title: Session two recap: Give an Agent a Body, Live

Opening paragraph: what the session set out to show and that it ran inside the world.
Section per agenda beat, in order, each with one screenshot from the recording.
The receipt link from the agent payment round.
Only counts from the measurement capture, each with its capture time.
The next session date (Tuesday, November 24) and how to request a showcase slot.
The independence line: three.ws is an IBM Business Partner. IBM does not endorse three.ws, and three.ws is not an IBM product.
```

### T+7 (Oct 22): proof note to IBM, and a short community wrap

Send the [seven-day proof note](../templates.md#seven-day-proof-note) to the same IBM thread as
section 2, with the completed [measurement](#measurement) fields attached. The one next-level
ask it earns, per the [event series](../opportunities.md#the-ibm-event-series): a
partner-authored recap on an IBM surface, and confirmation of the November 24 slot.

X:

```text
The objects the audience forged at our in-world IBM Community session are still standing. Walk in and find them. Next session: Tue Nov 24. https://three.ws/play?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t7-proof
```

LinkedIn:

```text
One week on from the Three.ws User Group session inside the 3D world. The replay, the receipt from the live agent payment, and every object the audience forged are still there to inspect. Session three is Tuesday, November 24: an agent buys a tool over HTTP and comes back with a result anyone can verify.

https://three.ws/play?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-09-ibm-event&utm_content=t7-proof
```

Telegram:

```text
Week-after note: the plaza still has everything you built on the 15th. The November 24 session is where an agent pays for its own tool, and we want two community showcases again. Reply here if you want a slot.
```

IBM Community (reply in the recap post's comments):

```text
A week later: the world still holds the objects forged during the session, and the next session is set for Tuesday, November 24, 12:00 PM Eastern (17:00 UTC). Showcase requests are open in this thread.
```

---

## 5. Run of show (minute by minute)

Times are minutes relative to the 16:00 UTC start (12:00 PM EDT for Option A). **Roles:**
Host (on stream, drives the world), Producer (second browser as an attendee, watches chat and the
stream, holds the fallbacks), Moderator (IBM Community thread, Telegram, and in-world chat).

| Time | ET | Segment | Who | Exactly what happens, with the real control | Fallback |
|---|---|---|---|---|---|
| -45 | 11:15 | Tech check | All | Host and Producer open `https://three.ws/event`, enter the world, confirm voice both ways (mic button in the HUD). Producer runs one `/forge a small wooden crate` in chat to warm the free lane | If voice fails, run the whole session on the stream audio and use text chat for the audience |
| -30 | 11:30 | Preshow starts (automatic) | None | The countdown chip turns gold and a toast tells players to stay: this is the `preshow` phase in [play-live-events.md](../../../docs/play-live-events.md), driven by `public/event.json` | None needed |
| -15 | 11:45 | Doors | Host, Moderator | Host stands at spawn and greets arrivals over voice. Teaches four keys aloud: WASD to move, Enter to chat, hold Q for the emote wheel, V to change avatar. First-time visitors also get the onboarding overlay automatically | Moderator pastes the same four keys in chat every five minutes |
| 0 | 12:00 | Go live (automatic) | None | The chip reads LIVE, the go-live banner fires, and an opening fireworks volley goes up for everyone at once (deterministic, no network) | None needed |
| 0 | 12:00 | Welcome | Host | Thirty seconds: who we are, the agenda, and the independence line read once: "three.ws is an IBM Business Partner. IBM does not endorse three.ws, and three.ws is not an IBM product." Producer posts the Live beat on all four channels | None needed |
| 2 | 12:02 | Tour | Host | Walk the plaza: the agenda drawer (tap the chip), the Agent Exchange where NOVA and ORACLE stand, the build area, the Plaza Stage marquee | Skip to the live build if arrivals are still coming in |
| 6 | 12:06 | Live build: prompt to rigged agent | Host | Switch the stream to a tab on `https://three.ws/create`. Type one sentence (rehearsed prompt: "a friendly lighthouse keeper in a yellow raincoat"). Show the generated avatar rig and animate | Producer has the same prompt's avatar pre-made at T-2; show it if generation runs past 12:12 |
| 12 | 12:12 | Wear it | Host | Back in the world, press V, pick the new avatar from saved avatars, and the rig swaps for every peer live. Hold Q and wave | Paste the pre-made avatar's URL into the same panel |
| 15 | 12:15 | Forge into the world | Host, audience | Host presses Enter and types `/forge a glass lighthouse lantern`. Draft generation lands in roughly 30 to 60 seconds (90 on a cold GPU); the toast says it is forged; one click places it for everyone. Invite the audience to forge their own now. Press B to show build mode | If the lane is slow, Producer places the crate forged at -45 from their build palette |
| 22 | 12:22 | IBM guest segment | [IBM SPEAKER] | Host introduces the speaker by the approved name and title only. 12 minutes of talk, 3 minutes of questions the Moderator collects from chat | If the speaker drops, Host moves the community showcase up and the IBM segment becomes a recorded follow-up post only with IBM's approval |
| 37 | 12:37 | An agent pays for a tool | Host | Walk to NOVA and ORACLE, press E, trigger one round. The x402 jumbotron steps through challenge, sign, verify, settle, confirmed, and the receipt shows a Solana explorer link. Read the amount off the panel, never from memory. **Spend:** one real stablecoin micropayment on Solana from the platform's server-side x402 payer; the owner approves the round count before the event | If a round fails, show the jumbotron's platform-wide feed of recent paid calls and open `https://three.ws/agent-exchange` in a tab |
| 42 | 12:42 | Community showcase | Host, up to three members | Members reserved in the T-14 thread walk up and talk over spatial voice: their avatar, their forged object, or their build. Three minutes each. Fireworks density starts ramping at 12:45 for the closing fifteen minutes | Host shows the T-7 challenge photos from Telegram and the IBM thread |
| 50 | 12:50 | Open Q&A | Host, Moderator | Moderator reads questions from chat, the IBM thread, and Telegram in turn | None needed |
| 57 | 12:57 | Group photo and next date | Host | Everyone gathers at the coin totem in the plaza. Host presses Z (zen, hides panels) then P: the photo card is stamped with the event name. Announce Tuesday, November 24 and the showcase sign-up | None needed |
| 60 | 13:00 | End (automatic) | None | Window closes: the souvenir grant (if configured) stops, the chip enters `afterglow` for 20 minutes inviting a photo, then the layer tears itself down | None needed |
| +20 | 13:20 | Capture | Producer | Record the [measurement](#measurement) fields at once; they are the only numbers the recap may use | None needed |

**What not to show on this stream:** the Oracle Ribbon in the plaza (it draws a `$THREE` price
forecast, and price talk does not belong on an IBM Community stage), any wallet UI, and any
`.env`.

---

## 6. Event config (`public/event.json`)

Write this file exactly (it replaces the no-event resting document), then validate it. It is the
single source for the `/event` countdown and calendar file, the lobby banner, the in-world chip,
agenda, banners, fireworks, and the souvenir grant.

```json
{
	"id": "user-group-session-2",
	"name": "Three.ws User Group: Give an Agent a Body, Live",
	"tagline": "The IBM Community user group session, held inside the world.",
	"startsAt": "2026-10-15T16:00:00Z",
	"endsAt": "2026-10-15T17:00:00Z",
	"link": "/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three",
	"linkLabel": "Join the session",
	"agenda": [
		{ "atMin": 0, "title": "Doors open in the plaza", "detail": "Welcome and controls" },
		{ "atMin": 6, "title": "Live build: prompt to rigged agent", "detail": "One sentence, then we wear it" },
		{ "atMin": 15, "title": "Forge into the world", "detail": "Type /forge in chat" },
		{ "atMin": 22, "title": "Guest segment", "detail": "Questions in chat" },
		{ "atMin": 37, "title": "An agent pays for a tool", "detail": "At the Agent Exchange" },
		{ "atMin": 42, "title": "Community showcase", "detail": "Members show what they brought" },
		{ "atMin": 50, "title": "Open Q&A", "detail": "Ask anything" },
		{ "atMin": 57, "title": "Group photo", "detail": "Gather at the totem" }
	]
}
```

```bash
npm run event:schedule          # validates with the deploy's own rules and prints the clock lines
git add public/event.json && git commit -m "feat(events): schedule Three.ws User Group session two for 2026-10-15 16:00 UTC"
```

The printed "announcement clock" lines must match the times in the posts above. Add the IBM
speaker's approved name to the `Guest segment` detail only once IBM confirms it.

**Souvenir (optional, agent-executable by T-14).** Do not point `souvenir.cosmeticId` at
`laurel-meetup`: that item is promised as never granted again. To give attendees a keepsake,
author a new `tier: 'event'`, `price: 0` item in `multiplayer/src/cosmetics-catalog.js`, generate
its GLB and poster, and add `"souvenir": { "cosmeticId": "<new id>" }`, following
[Adding a new souvenir](../../../docs/event-souvenirs.md#adding-a-new-souvenir). Then run
`npx vitest run tests/event-souvenir.test.js`.

**After the event, clear it.** `npm run check:event` is part of `npm run gate` and fails once a
window has ended, so the next deploy is blocked until the file returns to rest:

```bash
npm run event:schedule -- --clear --apply
git add public/event.json && git commit -m "chore(events): return the event config to rest after session two"
```

---

## Pre-flight and rehearsal

| When | Step | Command or action |
|---|---|---|
| T-14 | Config committed and deployed | Section 6, then the [deploy runbook](../../../CLAUDE.md#deploy-runbook-apifrontend) (owner-approved) |
| T-7 | Local rehearsal of every phase | `npm run event:schedule -- --rehearse 10 --apply`, then `npm run dev` and `npm run dev:walk-all` in two terminals, walk the whole run of show, take the photo-mode card for the T-1 image, then `git checkout -- public/event.json` |
| T-2 | Speaker rehearsal | 20 minutes in the world with the IBM speaker: voice, screen share, and their segment timing |
| T-2 | Pre-made fallbacks | Generate the live-build avatar and forge the lantern once; keep both URLs in the Producer's notes |
| T-1 | Production audit | `npm run audit:meetup -- --base https://three.ws` (drives the real layer with `?meetup=now`; exit 0 means every check passed) |
| T-1 | Agent Exchange rehearsal | One round in production. If it fails, run the `x402-economy-triage` agent before assuming the payer is empty |
| T-1 | Plaza Stage state | `GET https://three.ws/api/stage?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump` returns `{ stage: null }` while unclaimed (checked 2026-09-17), so the marquee reads "No host has claimed this stage". It is on the tour, not the agenda. Claiming it with a host agent (`POST /api/stage {action:'plaza'}`) is optional |

## Measurement

Capture at +20 minutes, again at 24 hours, and at 7 days, into the
[required campaign result](../measurement.md#required-campaign-result) fields. Sources that exist
today:

| Field | Where it comes from |
|---|---|
| Registrations | The IBM Community event listing's registrant count |
| Peak in-world population | The live population panel on `/event` during the session (screenshot it with its time) |
| Landing sessions | Web analytics filtered to `utm_campaign=mkt-2026-09-ibm-event`, split by `utm_source` |
| Forged objects placed | The plaza after the session (count what stands in the build area; photograph it) |
| Agent payment | The explorer receipt link from the live round |
| Partner response | IBM speaker, IBM listing, IBM social share: none, acknowledged, reposted, or authored |

No count goes into any post, recap, or proof note unless it is in this capture with its time.

---

## Feature verification

Every product claim in this kit, checked against the code on 2026-09-17:

| Claim | Source |
|---|---|
| `/play` needs no account or wallet | `src/game/play-gate.js` mounts only when a gate mint is pinned; the production service has no `PLAY_GATE*` variable |
| Countdown, agenda drawer, go-live banner, synchronized fireworks, `preshow` and `afterglow` phases | `src/game/meetup-event.js`, `src/game/meetup-schedule.js`, `src/game/fireworks.js`, [play-live-events.md](../../../docs/play-live-events.md) |
| `/event` countdown, add-to-calendar `.ics`, live population | `src/event-page.js` |
| Spatial voice by proximity | `src/game/voice-chat.js` |
| Keys: V avatar, Enter chat, hold Q emotes, E interact, B build, P photo, Z zen | `_bindInput` in `src/game/coincommunities.js`; listed for players in `src/game/play-onboard.js` |
| Swap avatar mid-session, including saved three.ws avatars and pasted URLs | `src/game/avatar-switcher.js` |
| `/forge <prompt>` in chat generates a prop on the free draft lane and places it for everyone | `_forgeProp` in `src/game/coincommunities.js`, `src/game/forge-prop.js` |
| NOVA pays ORACLE in a stablecoin on Solana through `/api/x402-pay`, only on an explicit E press, with an explorer receipt | `src/game/agent-commerce.js` |
| x402 jumbotron stepper and platform-wide paid-call feed | `src/game/x402-jumbotron.js`; `GET /api/x402-pay?feed=1` returned live items on 2026-09-17 |
| Photo mode stamps the event name | `src/game/photo-mode.js` |
| Plaza Stage marquee, unclaimed state | `src/game/plaza-stage.js`, `api/stage/index.js` |
| Souvenir window, world, and tier guards | [event-souvenirs.md](../../../docs/event-souvenirs.md), `multiplayer/src/event-drop.js` |

## Owner steps, in order

1. Pick Option A, B, or C (apply the find-and-replace table if not A).
2. Send the relationship email (section 2) on the June thread.
3. Send the Agent Connect email (section 3) to `IBMAgentConnect@ibm.com`.
4. When IBM confirms the speaker and wording, fill the three `[IBM SPEAKER]` fields and create
   the IBM Community event from section 1.
5. Commit section 6's `public/event.json` and deploy (T-14).
6. Approve the number of Agent Exchange rounds for rehearsal and the live session.
7. Post each beat of section 4 on its date.
8. Run the session from section 5; capture measurement at +20 minutes.
9. T+1: clear the event config and deploy; post the recap beats with captured numbers only.
10. T+7: send the proof note; update the `MKT-2026-09-IBM-EVENT` row's status in
    [campaigns.csv](../campaigns.csv).
