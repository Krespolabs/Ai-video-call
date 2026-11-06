# @three-ws/page-agent — Documentation

A rigged 3D AI agent that talks your visitors through any web page. This is the
full documentation. If you just want the elevator pitch and a one-line install,
the [package README](../README.md) has it.

> **New here?** Start with [Getting started](./getting-started.md). It takes ~5
> minutes and assumes nothing.

---

## Learning path

The docs are tiered. Pick your level — each guide links forward to the next.

### 🟢 Basic — *"I want a guide on my site, today."*

| Guide | What you'll learn |
|-------|-------------------|
| [Getting started](./getting-started.md) | Add the agent with one script tag. No build step, no framework, no account. |
| [Narrating your page](./guide-narration.md) | Make the agent read the *right* things, in the *right* order, in your own words. |
| [Troubleshooting & FAQ](./troubleshooting.md) | "No voice?" "Avatar won't load?" — the usual snags and their fixes. |

### 🟡 Medium — *"I'm wiring this into a real app."*

| Guide | What you'll learn |
|-------|-------------------|
| [Framework integration](./guide-frameworks.md) | Clean setup for React, Next.js, Vue, Svelte, Astro, and no-code (Webflow/WordPress). |
| [Recipes](./recipes.md) | Copy-paste solutions: analytics, gated tours, multi-language, route-aware narration, and more. |
| [API reference](./api-reference.md) | Every option, method, event, and type — the complete contract. |

### 🔴 Advanced — *"I want to push it further."*

| Guide | What you'll learn |
|-------|-------------------|
| [Custom avatars](./guide-custom-avatars.md) | Bring your own rigged GLB. Rigging, visemes, idle/talk clips, framing. |
| [Building blocks](./guide-building-blocks.md) | Drop the default UI. Compose `AvatarStage`, `SpeechNarrator`, `AvatarPicker`, and the lipsync engine into your own experience. |
| [Contributing](../CONTRIBUTING.md) | Add an agent, write a lipsync driver, ship a framework adapter — and the open roadmap of things worth building. |

---

## The three ways to use it

Everything in these docs is one of three integration styles. They share the same
engine; you can move between them as your needs grow.

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Zero-JS script tag      <script ... data-page-agent>          │  🟢 basic
│     Drop one tag. Done.                                           │
├─────────────────────────────────────────────────────────────────┤
│  2. <page-agent> element     <page-agent auto-narrate>            │  🟢 basic
│     Declarative HTML. Methods + events on the element.            │
├─────────────────────────────────────────────────────────────────┤
│  3. new PageAgent(config)    import { PageAgent }                 │  🟡 medium
│     Full programmatic control: narrate(), events, live swaps.     │
├─────────────────────────────────────────────────────────────────┤
│  4. Building blocks          AvatarStage + SpeechNarrator + …     │  🔴 advanced
│     Your own UI around the rendering/speech/lipsync engine.       │
└─────────────────────────────────────────────────────────────────┘
```

## Mental model in 30 seconds

`PageAgent` is a thin controller that composes four pieces:

```
PageAgent ─┬─ AvatarStage     three.js scene. Loads the rigged GLB, frames it
           │                  (bust/upper/full), keeps it alive with an idle
           │                  clip or procedural breathing + blink.
           ├─ SpeechNarrator  A speech queue on the Web Speech API. Picks a
           │                  voice per agent and drives lipsync on the frame loop.
           ├─ AvatarPicker    Accessible modal so the *visitor* chooses a guide.
           └─ lipsync         text → timed visemes → morph-target influences.
```

No backend, no API key, no audio files. Speech is the browser's
`SpeechSynthesis`; lipsync is a deterministic text-to-viseme heuristic advanced
on three.js's render loop. When speech is unavailable or muted, the avatar still
"talks" visually and captions render — narration never silently stalls.

## Requirements

- A modern browser with WebGL. (Speech is best in Chrome/Edge/Safari; see
  [Troubleshooting](./troubleshooting.md#speech) for the Firefox caveat.)
- `three` >= 0.150 as a peer dependency **only** for the bundler/ESM path. The
  CDN `/dist/page-agent.global.js` build inlines three, so the script-tag path
  needs nothing.

## Where the assets come from

Avatars stream from the public three.ws asset host
(`https://three.ws/avatars/*.glb`) by default — real, ready to use, no setup. To
self-host, point [`assetBase`](./api-reference.md#config) (or an agent's `url`) at
your own CDN. See [Custom avatars](./guide-custom-avatars.md).

---

Questions, bugs, ideas → [open an issue](https://github.com/nirholas/three.ws/issues)
or read [CONTRIBUTING](../CONTRIBUTING.md). Part of the
[three.ws](https://three.ws) platform for building, animating, rigging, and
monetizing 3D AI agents.
