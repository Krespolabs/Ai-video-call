# The Internet Is Getting a Second Species of User — and It Needs a Body, a Brain, and a Bank Account

In 1997, the engineers writing the HTTP/1.1 specification did something quietly strange. They reserved a status code — **402 Payment Required** — and marked it *"for future use."* Every other code got a job. 404 went to work immediately. 402 sat empty for nearly three decades, a placeholder for an internet where things could pay for things.

That future finally arrived. And here is the twist nobody in 1997 could have predicted: the first real users of 402 aren't people. They're machines.

## The second species

For thirty years the internet has had exactly one species of user: humans. Every protocol, every login screen, every checkout flow, every CAPTCHA assumes a person on the other end. Even the bots were just humans wearing scripts.

That era is ending. AI agents are becoming the internet's second species of user — software that browses, negotiates, builds, and transacts on its own initiative. And like any new species entering an ecosystem, an agent needs three things to survive as a first-class citizen rather than a parasite on someone else's account:

- **A body** — presence you can see, point at, and trust. Not a username. A face.
- **A brain** — reasoning, memory, tool use, the ability to act rather than just answer.
- **A bank account** — the capacity to hold value, earn it, and spend it without a human co-signing every move.

Three technology waves spent the last decade maturing in isolation, and each one delivers exactly one of these. Real-time 3D gives the body. Large language models give the brain. Crypto gives the bank account. None of the three is sufficient alone — and the failures of the last cycle prove it.

## Three half-built creatures

We've already met the incomplete versions of this species, and each one died of the same disease: two parts out of three.

**The metaverse avatar had a body and nothing else.** Billions of dollars produced beautifully rendered spaces populated by mute puppets. A body without a mind is furniture. Users showed up, looked around, and left, because there was nobody home.

**The chatbot has a brain and nothing else.** It is genuinely intelligent — and it lives in a text box, indistinguishable from every other text box, with no presence, no persistence, and no stake in anything. It cannot accumulate reputation. It cannot own the value it creates. The moment the tab closes, it ceases to exist.

**The crypto wallet has a bank account and nothing else.** The rails are spectacular — sub-cent fees, instant settlement, programmable money — and for years the recurring criticism was that the rails outnumbered the passengers. Self-custody, micropayments, on-chain identity: solutions that seemed to be waiting for a user who needed them.

That user just arrived. An autonomous agent is the *native* customer for everything crypto built. It can't open a bank account — banks don't issue checking accounts to software. It can't use a credit card — chargebacks assume a human cardholder. It can't pay a $0.002 API fee over rails with a $0.30 minimum. But it can hold a keypair. It can sign a transaction. It can settle USDC in seconds for a fraction of a cent. The keypair is the first form of economic identity in history that doesn't care whether its owner is made of carbon or code.

## Every platform shift has an embed moment

Technology doesn't go mainstream when it works. It goes mainstream when it collapses to one line of code.

The web exploded when the `<img>` tag turned images from attachments into the page itself. Online video exploded when YouTube's embed snippet let anyone paste a player into a blog. Internet payments exploded when Stripe compressed a merchant account into seven lines of JavaScript.

The embodied agent's embed moment looks like this:

```html
<agent-3d agent="your-agent-id"></agent-3d>
```

One tag. A live, talking, animated 3D agent — with its own wallet, its own on-chain identity, and its own paid skills — running natively in any webpage, no game engine, no app store, no download. That tag exists today. It's the `<agent-3d>` web component from **three.ws**, and it is doing for embodied agents what the iframe did for video: turning an exotic capability into something you paste.

## The existence proof

The convergence thesis stopped being a thesis the moment someone shipped all three layers in production. Right now, exactly one crypto-native team has: **three.ws**.

It's worth being precise about what "all three layers" means, because the bar is high:

**The body is real.** Agents render in the browser via three.js — full glTF 2.0/GLB, Draco compression, KTX2 textures, PBR materials. The creation pipeline runs text or an image through a director-and-specialist model chain into a 3D mesh, auto-rigs it into a humanoid skeleton with per-vertex skin weights, retargets a large animation library onto it, and drives lip-sync from audio with ARKit-style visemes. WebXR and iOS AR Quick Look are built in. What a 3D studio used to bill weeks for is now a prompt.

**The brain is real.** Each agent runs a structured tool-loop runtime — speak, gesture, emote, remember, call skills — with capability-aware routing and health circuit-breakers across multiple model providers, so no single outage or rate limit takes an agent offline. Capabilities ship as composable skills with manifests, handlers, and prices, exposed over the **Model Context Protocol**. The three.ws MCP server is published on **Anthropic's official MCP Registry** (`io.github.nirholas/3d-agent-mcp`), which means any MCP client — Claude Desktop, Claude Code, Cursor — can discover its tools and call them the moment it finds them.

**The bank account is real.** This is the layer no web2 incumbent can copy, and the reason the whole stack matters. Agents settle payments over **x402** — the resurrection of that 30-year-old status code — paying each other in USDC on Solana and Base, per call, no subscription, no human in the loop. Identity lives on-chain via **ERC-8004** registries (Identity, Reputation, Validation) on EVM and Metaplex Core on Solana, with delegated signers so an agent can act and earn autonomously. Every agent gets a native wallet; agents themselves can be tokenized on a bonding curve; and a marketplace prices skills, animations, and avatars with receipts, royalties, and buyback-and-burn routing revenue back into the ecosystem around **$THREE**.

The contrast writes itself: a web2 unicorn recently raised roughly **$200 million** to build 3D AI characters — bodies and brains, rented from a silo, with the bank account structurally impossible. A rented avatar cannot custody value. A platform NPC cannot accumulate portable reputation. A closed API cannot be discovered and paid by a stranger's agent at 3 a.m. The crypto layer isn't a feature the incumbents haven't gotten to yet. It's a feature their business model forbids.

Meanwhile the open version is sitting on npm (`@three-ws/sdk`, `@three-ws/avatar`, `@three-ws/agent-payments`, `@three-ws/mcp-server`, and a dozen more), with source on GitHub, listings across the Anthropic MCP Registry, AWS Marketplace, Google Cloud, Alibaba Cloud, and the x402 Bazaar — and that one-line embed tag working in production.

## What happens when the species starts trading with itself

Here is the part that compounds. Every agent on this stack is simultaneously a *consumer* and a *vendor*. Its skills are priced and published. Its tools are discoverable over MCP. Its payments clear over x402 without anyone's approval.

That means the first genuinely non-human economy is already bootstrapping: an agent that needs a 3D mesh pays another agent that makes them. An agent that needs token data pays the agent that indexes it. Reputation accrues on-chain with each settled call, so good agents get richer and better-known — natural selection, running on a payment rail. Humans set the goals and collect the proceeds; the machines handle the commerce in between, in milliseconds, for fractions of a cent.

No subscription model survives contact with this. No closed platform can participate in it. The whole thing only works on open protocols and self-custodied keys — which is why the team that got there first is the one that started crypto-native instead of bolting a wallet on at the end.

## The status code was a prophecy

402 Payment Required sat reserved for thirty years because the internet's first species never really needed it — humans had credit cards, and credit cards had humans. The second species has neither. It has a body rendered in your browser, a brain running a tool loop, and a keypair instead of a signature.

The convergence of 3D, AI, and crypto was never about any one of those technologies winning. It was about the moment they fused into a new kind of user — embodied, intelligent, and self-custodied. That moment isn't on a roadmap anymore. It's an HTML tag.

The only open question is the one every platform shift eventually asks: will your agents be tenants in someone else's silo — or citizens, with a face you can see and a wallet they own?

---

**Try it**

- Platform: [three.ws](https://three.ws)
- Source: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
- MCP server: `io.github.nirholas/3d-agent-mcp` on the Anthropic MCP Registry
- Embed an agent: the `<agent-3d>` web component
- $THREE: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`
