# Three World Session: the monthly template

The **Three World Session** is the monthly community event in the
[command center](../README.md#3-the-community-becomes-the-stage): one hour inside
`three.ws/play`, where the venue is the demo. This file is the reusable kit. Part 1 is the
template any month fills in; Part 2 is the filled-in November 2026 session
(`MKT-2026-11-IBM-WORLD-2`), which follows October's
[IBM Community event two](./ibm-event-two.md) and uses the same structure, rules, and tooling.

---

# Part 1: the template

## The slots a month fills

Everything else in a session kit is fixed. Decide these nine values, and the rest of the kit is
mechanical.

| Slot | Rule | Where it is used |
|---|---|---|
| Campaign ID | The existing row in [campaigns.csv](../campaigns.csv); never renamed | Every UTM `utm_campaign`, the measurement row |
| Date | A Tuesday or Thursday. Prefer Thursday (the live-demo day in the [weekly rhythm](../README.md#weekly-operating-rhythm)) unless the campaign row already fixes a Tuesday | Posts, event page, `public/event.json` |
| Start (UTC) | 16:00 UTC while US Eastern is on daylight time (12:00 PM EDT); 17:00 UTC once it is on standard time (12:00 PM EST). In 2026 US daylight time ends November 1 | Everything with a time |
| Theme | One claim a viewer can verify during the hour | Title, abstract, X anchor |
| Proof surface | A shipped route, verified in code before the kit is written (see [feature verification](./ibm-event-two.md#feature-verification) for the method) | Run of show, links |
| Guest | Named only after the guest approves the wording; partners are speakers, not co-hosts, until they approve co-host wording | Speaker slot |
| Partner ask | Exactly one, from the campaign row | Relationship note, T+7 proof note |
| Community challenge | A one-week task that produces something to show on stream | T-7 posts, showcase segment |
| Souvenir | Optional. A new `tier: 'event'` item per [event-souvenirs.md](../../../docs/event-souvenirs.md); never re-grant a past one | `public/event.json` |

## The fixed timeline

| Beat | What ships | Channels |
|---|---|---|
| T-21 | Slots decided; relationship note to the venue partner; guest invited with the [speaker invitation](../templates.md#event-speaker-invitation) | Email |
| T-14 | Event page created; `public/event.json` committed and deployed; announcement posts | IBM Community (new thread), X, LinkedIn, Telegram |
| T-7 | Demo image or clip; community challenge opens; local rehearsal | X, LinkedIn, Telegram, IBM Community (reply in thread) |
| T-2 | Guest rehearsal; fallback assets generated | Internal |
| T-1 | Reminder with exact UTC and Eastern times; `npm run audit:meetup -- --base https://three.ws` | X, LinkedIn, Telegram, IBM Community (reply in thread) |
| Live | Live post at the start minute | All four |
| T+1 | Event config cleared and deployed; replay clip; recap blog with captured numbers only | All four; IBM Community gets a blog post |
| T+7 | [Seven-day proof note](../templates.md#seven-day-proof-note) to the partner; week-after posts | Email, all four |

## The fixed run-of-show frame

Sixty minutes, with doors fifteen minutes early. The segment contents change monthly; the frame
does not, because `public/event.json` agenda beats, the preshow chip, and the fireworks ramp all
assume it.

| Minute | Segment | Fixed element |
|---|---|---|
| -45 | Tech check | Host and Producer in the world; warm the lanes the session uses |
| -30 | Preshow (automatic) | Gold countdown chip |
| -15 | Doors | Host at spawn teaching WASD, Enter, hold Q, V |
| 0 | Welcome | Go-live banner and volley (automatic); independence line read once when a partner venue is involved |
| 2 to 22 | Theme segments | Two demos on the proof surface, each with a pre-made fallback |
| 22 to 37 | Guest segment | Fifteen minutes including three of questions |
| 37 to 50 | Proof and showcase | The verifiable moment, then up to three community showcases |
| 50 to 57 | Open Q&A | Moderator reads chat, the IBM thread, and Telegram in turn |
| 57 to 60 | Group photo and next date | Z then P at the coin totem; the photo card carries the event name |
| 60 | End (automatic) | Afterglow for 20 minutes, then the layer tears down |

## The fixed rules

- No hashtags, no emoji, no em or en dashes. Every X post carries an image and is checked with
  `node scripts/post-tweet.mjs --text "<post>" --dry-run`; target 100 to 179 weighted characters
  ([announce-voice.md](../../../docs/announce-voice.md)).
- IBM-facing copy follows [badge-usage.md](../../ibm-partner-plus/badge-usage.md). No `@IBM`
  tag while Granite is not serving in production.
- UTM format from [measurement.md](../measurement.md); `utm_content` is `t14`, `t7`, `t1`, `live`,
  `t1-recap`, or `t7-proof`.
- No count appears in any post, recap, or proof note unless it was captured with its time.
- Any real spend shown on stream (an x402 round, a payment from a wallet) is approved by the
  owner beforehand, with recipient, amount, and chain.
- After the window ends, `npm run event:schedule -- --clear --apply`, commit, deploy:
  `npm run check:event` (inside `npm run gate`) fails on an expired window.

## To make next month's kit

1. Copy Part 2 of this file into a new section below it, titled with the month and campaign ID.
2. Replace the nine slots, then recompute the T-dates and the UTC/Eastern line from the date.
3. Re-verify every route in the run of show against the code and a live `curl`, and record the
   check date in the verification table.
4. Link the new section from [events/README.md](./README.md).

---

# Part 2: November 2026, `MKT-2026-11-IBM-WORLD-2`

## Slots

| Slot | Value |
|---|---|
| Campaign ID | `MKT-2026-11-IBM-WORLD-2` |
| Date | **Tuesday, November 24, 2026** (the campaign row's date) |
| Start | **17:00 to 18:00 UTC**: 12:00 to 1:00 PM EST, 9:00 AM PST, 5:00 PM London, 6:00 PM Berlin |
| Theme | An agent buys a tool and returns with a result you can verify |
| Proof surface | The Agent Exchange in `/play` and its x402 jumbotron; `/x402`; `/ibm/x402-demo`; `/receipts` |
| Guest | [IBM SPEAKER: name, title, and topic, supplied and approved by IBM] |
| Partner ask | IBM event amplification and a partner-authored recap (from the campaign row) |
| Community challenge | Make one paid x402 call from your own wallet on `/ibm/x402-demo` and bring the receipt |
| Souvenir | Optional; a new item, never `laurel-meetup` |

**Calendar risk:** November 24 is the Tuesday of US Thanksgiving week (Thanksgiving is November
26), which can thin a US enterprise audience. If IBM prefers, move to **Tuesday, November 17,
2026, 17:00 UTC (12:00 PM EST)**: shift every T-date below one week earlier, then replace
`November 24` with `November 17`, `Nov 24` with `Nov 17`, and `2026-11-24` with `2026-11-17`
across Part 2 (the relationship note already offers both dates, so leave it as written).

| Beat | Date |
|---|---|
| T-21 | Tuesday, November 3 |
| T-14 | Tuesday, November 10 |
| T-7 | Tuesday, November 17 |
| T-1 | Monday, November 23 |
| Live | Tuesday, November 24, 17:00 UTC |
| T+1 | Wednesday, November 25 |
| T+7 | Tuesday, December 1 |

## Event page (IBM Community)

Title:

```text
An Agent Pays for Its Own Tool: Three.ws User Group Session Inside the 3D World
```

Abstract:

```text
An AI agent that can use a paid tool needs a way to pay for it without a person typing in a
card. In this session the Three.ws User Group meets inside the three.ws 3D world and watches
that happen end to end: an agent asks a service for a tool, receives an HTTP 402 payment
challenge, signs and settles a micropayment, gets the result, and leaves a public on-chain
receipt that anyone in the audience can open.

You join from your browser as an avatar. No download, no install, no account. Trying the
payment yourself is optional and uses your own wallet.

Hosted by three.ws in the Three.ws User Group on IBM Community. three.ws is an IBM Business
Partner. IBM does not endorse three.ws, and three.ws is not an IBM product.
```

Agenda:

```text
12:00 PM ET  Doors open in the plaza. Welcome, and how to move, talk, and emote.
12:03 PM ET  How an agent pays: the HTTP 402 challenge in one minute, on a real catalog.
12:08 PM ET  Round one in the world: two agents settle a payment at the Agent Exchange.
12:16 PM ET  Your turn, optional: one paid call from your own wallet, receipt included.
12:22 PM ET  Guest segment: [IBM SPEAKER: name, title, and topic, supplied and approved by IBM]
12:37 PM ET  Verify it yourself: signed receipts and the live payment feed.
12:44 PM ET  Community showcase: members show what they built or paid for.
12:50 PM ET  Open Q&A.
12:57 PM ET  Group photo, and the date of the next session.
```

Details and login instructions: reuse the two blocks from
[event two, section 1](./ibm-event-two.md#event-details-table) with this line swapped in:

```text
When:          Tuesday, November 24, 2026, 12:00 to 1:00 PM Eastern (17:00 to 18:00 UTC)
Your time:     9:00 AM San Francisco, 12:00 PM New York, 5:00 PM London, 6:00 PM Berlin
```

Registration CTA:

```text
Register on IBM Community to get the reminder, then add it to your calendar at three.ws/event.
```

## Relationship note (T-21, November 3)

Reply on the same IBM thread as event two's note:

```text
Subject: Three.ws User Group session three on November 24, and a recap ask

Hi [IBM CONTACT FIRST NAME],

Thank you again for [ONE SENTENCE ON IBM'S ACTUAL CONTRIBUTION TO EVENT TWO, from the T+7
measurement]. Session three is set for Tuesday, November 24, 12:00 PM Eastern (17:00 UTC), inside
the three.ws world again: an AI agent requests a paid tool, receives an HTTP 402 challenge,
settles a micropayment, and returns a result with a public receipt the audience can open.

Two asks. First, a 15-minute IBM speaker segment and a listing on the IBM Community events
calendar, as last time; the event page copy is ready. Second, would an IBM author be willing to
write the recap on an IBM surface afterwards? We will supply the recording, screenshots, receipt
links, and captured numbers within 24 hours.

If Thanksgiving week is a problem for your audience, we can hold Tuesday, November 17 instead.

Thank you,
Nich
three.ws
```

## Posts

Links follow the table in [event two, section 4](./ibm-event-two.md#4-posts) with
`utm_campaign=mkt-2026-11-ibm-world-2`. X posts are shown fully resolved.

### T-14 (November 10)

X:

```text
How does an AI agent pay for a tool with no card? Live inside the three.ws world: HTTP 402, a signed micropayment, a public receipt. Tue Nov 24, 17:00 UTC. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t14
```

LinkedIn:

```text
An AI agent that uses paid tools needs a way to pay for them without a person typing in a card number.

On Tuesday, November 24, the Three.ws User Group on IBM Community shows the whole loop, live, inside the three.ws 3D world: an agent requests a tool, receives an HTTP 402 payment challenge, signs and settles a micropayment on Solana, gets its result, and leaves a receipt anyone in the audience can open and check.

12:00 PM Eastern / 17:00 UTC. Free, in the browser, no account. Trying a paid call yourself is optional and uses your own wallet.

https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t14

three.ws is an IBM Business Partner. IBM does not endorse three.ws, and three.ws is not an IBM product.
```

Telegram:

```text
Next community session: Tuesday, November 24, 17:00 UTC (12:00 PM Eastern), in the $THREE home town on three.ws/play.

Theme: an agent pays for its own tool. We run the Agent Exchange on stream, walk through the x402 challenge step by step, and open the Solana receipts together. Then your showcase.

https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t14
```

IBM Community (new thread):

```text
Title: November 24: An Agent Pays for Its Own Tool (Three.ws User Group session three)

Session three is Tuesday, November 24, 12:00 to 1:00 PM Eastern (17:00 UTC), inside the three.ws world again.

The question for the hour: how does an AI agent pay for a tool it needs without a person in the loop, and how does anyone check that it happened? We will show an agent request a paid tool, receive an HTTP 402 payment challenge, sign and settle a micropayment, and return with the result, then open the public receipt together. A guest segment and a member showcase follow.

Join at https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t14 at the start time. No download, no account.

Showcase slots: reply here if you have built something that pays for or charges for a tool.
```

### T-7 (November 17): challenge

X:

```text
Challenge before Nov 24: make one paid API call from your own Solana wallet, watch the 402 challenge settle, bring the receipt. Best ones go on stream. https://three.ws/ibm/x402-demo?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t7
```

LinkedIn:

```text
A one-week warm-up before Tuesday, November 24.

The x402 live demo page pays a fraction of a cent in a dollar stablecoin from your own wallet to call a real three.ws data API. You see the HTTP 402 challenge arrive, sign the authorization, and get the settlement receipt with its explorer link. A Solana wallet works, and so does an EVM wallet.

Try one call, then bring the receipt to the session. Showcase slots go to the three most interesting things people do with it.

https://three.ws/ibm/x402-demo?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t7
```

Telegram:

```text
Challenge for the November 24 session: one paid call from your own Solana wallet on the x402 demo, then post the explorer receipt link here. Amounts are shown before you sign. The best three go on stream.

https://three.ws/ibm/x402-demo?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t7
```

IBM Community (reply in the T-14 thread):

```text
One week out. Optional warm-up: the x402 live demo makes one paid API call from your own wallet and shows the HTTP 402 challenge, the signed authorization, and the settlement receipt. Post what you notice in this thread and we will pick questions for the session.

https://three.ws/ibm/x402-demo?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t7
```

### T-1 (November 23)

X:

```text
Tomorrow inside the three.ws world: an agent pays for its own tool and we open the receipt together. 17:00 UTC, 12:00 PM Eastern. No account. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t1
```

LinkedIn:

```text
Tomorrow, Tuesday, November 24: the Three.ws User Group session inside the 3D world. 17:00 UTC / 12:00 PM Eastern / 9:00 AM Pacific / 5:00 PM London. Open the link in a desktop browser at the start time; the team is at the spawn point 15 minutes early.

https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t1
```

Telegram:

```text
Tomorrow: 17:00 UTC (12:00 PM Eastern, 5:00 PM London). Chip goes gold in the plaza 30 minutes before; we are at spawn 15 minutes early. Bring your receipts.

https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t1
```

IBM Community (reply in the T-14 thread):

```text
Reminder: tomorrow, Tuesday, November 24, 12:00 to 1:00 PM Eastern (17:00 UTC). Open https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t1 in a desktop browser at the start time.
```

### Live (November 24, at 12:00 PM ET)

X:

```text
Live now in the three.ws world: in eight minutes two agents settle a real payment for a tool, and we open the receipt on stream. Walk in, no account. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=live
```

LinkedIn:

```text
We are live inside the three.ws world for the Three.ws User Group session. The first agent payment round starts at 12:08 PM Eastern.

https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=live
```

Telegram:

```text
LIVE now in the $THREE home town. First payment round in eight minutes: https://three.ws/event?utm_source=telegram&utm_medium=community&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=live
```

IBM Community (reply in the T-14 thread):

```text
We are live. Join here: https://three.ws/event?utm_source=ibm-community&utm_medium=partner&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=live
```

### T+1 (November 25)

Bracketed values come only from the measurement capture; delete a sentence whose value was not
captured.

X:

```text
Replay: an agent hit an HTTP 402, signed a micropayment, got its tool result, and the receipt is public on Solana for anyone to check. https://three.ws/event?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t1-recap
```

LinkedIn:

```text
Yesterday's Three.ws User Group session, recapped.

In order: the HTTP 402 challenge on a live catalog; two agents at the Agent Exchange settling a payment for a tool, with the receipt opened on stream ([EXPLORER URL FROM THE LIVE ROUND]); attendees making their own paid calls; [IBM SEGMENT SUMMARY: one sentence, approved by the IBM speaker]; and member showcases.

[ATTENDANCE SENTENCE, only from the captured peak count.]

The next session date is announced first in the Three.ws User Group on IBM Community.

https://three.ws/event?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t1-recap
```

Telegram:

```text
Thank you for coming in yesterday. Replay clip above, and every receipt from the session is public on the Solana explorer. The next date goes up here as soon as it is booked.
```

IBM Community: a recap blog post within 24 hours, same outline as
[event two's T+1 recap](./ibm-event-two.md#t1-oct-16-replay-links-next-date), drafted in
`docs/ibm-community-blog-session-3-recap.md`. If IBM agreed to author the recap, send them the
draft and the assets instead and link their post when it is live.

### T+7 (December 1)

Send the [seven-day proof note](../templates.md#seven-day-proof-note) on the IBM thread with the
completed measurement.

X:

```text
A week on, every receipt from our in-world session is still public. That is the point of an agent paying on-chain: nobody has to take our word for it. https://three.ws/agent-exchange?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t7-proof
```

LinkedIn:

```text
One week after the session: the receipts from every payment made on stream are still public, and the Agent Exchange runs every day in the three.ws world for anyone who wants to watch agents settle a payment themselves.

https://three.ws/agent-exchange?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-11-ibm-world-2&utm_content=t7-proof
```

Telegram:

```text
Week-after note: the Agent Exchange is in every coin town on three.ws/play, any day. Walk up to NOVA and ORACLE and press E. Next session sign-ups are open in this chat.
```

IBM Community (reply in the recap post's comments):

```text
A week later, the receipts from the session are still public, and the Agent Exchange is available in the world any day for anyone who wants to watch a payment settle. Suggestions for the next session's theme are welcome here.
```

## Run of show

Times relative to 17:00 UTC (12:00 PM EST). Roles as in event two: Host, Producer, Moderator.

| Time | ET | Segment | Exactly what happens | Fallback |
|---|---|---|---|---|
| -45 | 11:15 | Tech check | Host and Producer in the world; Producer runs one Agent Exchange round (owner-approved) and opens `/x402`, `/ibm/x402-demo`, and `/receipts` in tabs | If the round fails, run the `x402-economy-triage` agent before the event rather than assuming the payer is empty |
| -30 | 11:30 | Preshow (automatic) | Gold chip | None needed |
| -15 | 11:45 | Doors | Host at spawn teaching WASD, Enter, hold Q, V | Moderator pastes keys in chat |
| 0 | 12:00 | Welcome | Go-live banner and volley; independence line read once; Producer posts Live beats | None needed |
| 3 | 12:03 | How an agent pays | Tab on `https://three.ws/x402`: open one endpoint, show its price and schema. One sentence each on the 402 challenge, the signed authorization, and settlement | Describe it over the jumbotron in the world |
| 8 | 12:08 | Round one in the world | Walk to NOVA and ORACLE, press E. NOVA pays ORACLE for its `tools/list` catalog through `/api/x402-pay`; the x402 jumbotron steps challenge, sign, verify, settle, confirmed; open the explorer link from the receipt. Read the amount off the panel | Show the jumbotron's platform-wide feed of recent paid calls |
| 16 | 12:16 | Your turn (optional) | Show `https://three.ws/ibm/x402-demo`. Attendees who want to pay use their own wallet; the Host demonstrates only with a dedicated demo wallet that shows nothing else, and only with the owner's prior approval of that payment | Skip if nobody wants to try; do not pressure anyone to spend |
| 22 | 12:22 | IBM guest segment | [IBM SPEAKER], 12 minutes plus 3 of questions | Move the showcase up |
| 37 | 12:37 | Verify it yourself | `https://three.ws/receipts`: connect a wallet, sign one read-only message, and list its signed receipts with explorer links. Then `https://three.ws/pulse` for the live feed of agent wallet activity | Open the round-one explorer link again |
| 44 | 12:44 | Community showcase | Up to three members from the T-14 thread, over spatial voice | Show challenge receipts posted in Telegram and the IBM thread |
| 50 | 12:50 | Open Q&A | Moderator rotates chat, IBM thread, Telegram | None needed |
| 57 | 12:57 | Group photo and next date | At the coin totem: Z then P | None needed |
| 60 | 13:00 | End (automatic) | Afterglow, then teardown; Producer captures measurement at +20 | None needed |

**Do not show:** the Oracle Ribbon's price forecast, token price talk, or any wallet holding
other than the dedicated demo wallet.

## Event config

```json
{
	"id": "user-group-session-3",
	"name": "Three.ws User Group: An Agent Pays for Its Own Tool",
	"tagline": "The IBM Community user group session, held inside the world.",
	"startsAt": "2026-11-24T17:00:00Z",
	"endsAt": "2026-11-24T18:00:00Z",
	"link": "/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three",
	"linkLabel": "Join the session",
	"agenda": [
		{ "atMin": 0, "title": "Doors open in the plaza", "detail": "Welcome and controls" },
		{ "atMin": 3, "title": "How an agent pays", "detail": "HTTP 402 on a live catalog" },
		{ "atMin": 8, "title": "Round one at the Agent Exchange", "detail": "Two agents settle a payment" },
		{ "atMin": 16, "title": "Your turn", "detail": "Optional, your own wallet" },
		{ "atMin": 22, "title": "Guest segment", "detail": "Questions in chat" },
		{ "atMin": 37, "title": "Verify it yourself", "detail": "Signed receipts and the live feed" },
		{ "atMin": 44, "title": "Community showcase", "detail": "Members show what they built" },
		{ "atMin": 50, "title": "Open Q&A", "detail": "Ask anything" },
		{ "atMin": 57, "title": "Group photo", "detail": "Gather at the totem" }
	]
}
```

Write it at T-14 (after event two's config has been cleared), run `npm run event:schedule` to
validate and print the clock lines, commit, and deploy. Clear it at T+1 with
`npm run event:schedule -- --clear --apply`.

## Feature verification (checked 2026-09-17)

| Claim | Source |
|---|---|
| NOVA pays ORACLE for its `tools/list` catalog through `/api/x402-pay`, on an explicit E press only, a stablecoin payment on Solana, explorer receipt | `src/game/agent-commerce.js` |
| The jumbotron steps challenge, sign, verify, settle, confirmed and shows a platform-wide feed | `src/game/x402-jumbotron.js`; `GET /api/x402-pay?feed=1` returned live items |
| `/ibm/x402-demo` pays a sub-cent stablecoin amount from the visitor's own wallet (Solana, or an EVM chain) and shows the receipt | `data/pages.json` entry; route answered 200 |
| `/receipts` lists signed x402 receipts for a wallet after one read-only signature | `data/pages.json` entry for Receipt Vault |
| `/x402`, `/agent-exchange`, `/pulse`, `/event`, `/play` are live | Each answered 200 on 2026-09-17 |
| World features (chip, agenda, fireworks, photo stamp, keys) | See [event two's verification table](./ibm-event-two.md#feature-verification) |

## Owner steps, in order

1. Confirm November 24 or the November 17 alternative (T-21, November 3), and send the
   relationship note.
2. When IBM confirms the speaker and wording, fill the `[IBM SPEAKER]` fields and create the event.
3. Commit and deploy the event config (T-14, November 10).
4. Approve the Agent Exchange rounds and any Host demo-wallet payment, with amount and chain.
5. Post each beat on its date; run the session; capture measurement at +20 minutes.
6. Clear the config and deploy (T+1); post recaps with captured numbers only.
7. Send the proof note (T+7) and update the campaign row's status.
