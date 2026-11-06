# API reference 🟡

The complete public surface of `@three-ws/page-agent`. Everything here is
exported from the package entry and typed in
[`types/index.d.ts`](../types/index.d.ts).

- [PageAgent](#pageagent) — the drop-in controller
- [HTML: `<page-agent>` element](#html-page-agent-element)
- [HTML: `data-page-agent` script](#html-attributes)
- [Persona presets](#persona-presets) — `preset` + `context`
- [Catalog](#catalog) — agents + helpers
- [Building blocks](#building-blocks) — `AvatarStage`, `SpeechNarrator`, `AvatarPicker`
- [Lipsync engine](#lipsync-engine)
- [Types](#types)

---

## `PageAgent`

```ts
import { PageAgent } from '@three-ws/page-agent';
const guide = new PageAgent(config?);
```

The controller docks a rigged 3D agent to the page corner with a control bar,
caption bubble, drag-to-move, and page narration. It appends itself to
`document.body` — you don't mount it into an element.

> Throws `'[page-agent] requires a browser environment'` if constructed where
> `window` is undefined (SSR). Construct it in a client-only effect.

### Config

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `agent` | `string` | persisted → `'sol'` | Initial rigged agent id. |
| `agents` | `string[]` | all | Allow-list of ids shown in the picker. Invalid/empty falls back to the full roster. |
| `assetBase` | `string` | `https://three.ws/avatars/` | Base URL for agent GLBs. |
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | `'bottom-right'` | Dock corner (until dragged). |
| `muted` | `boolean` | `false` | Start muted — visual lipsync + captions only. |
| `collapsed` | `boolean` | `false` | Start as the "Ask a guide" launcher pill. |
| `picker` | `boolean` | `true` | Show the change-agent affordance + picker. |
| `controls` | `boolean` | `true` | Show the control bar. |
| `greeting` | `string` | — | Spoken once on load. Ignored when `autoNarrate` is set. |
| `autoNarrate` | `boolean \| string` | `false` | `true` tours the whole page; a string is a CSS selector of segments to tour. |
| `persistAgent` | `boolean` | `true` | Remember the visitor's chosen agent in `localStorage`. |
| `mount` | `HTMLElement` | — | Reserved; the agent docks itself regardless. |
| `preset` | `string` | — | Persona preset id. See [Persona presets](#persona-presets). Explicit `greeting`/`suggestedPrompts`/`tools` below win over the preset's defaults. |
| `context` | `Record<string, unknown>` | — | Host-page state, sanitized and folded into `.systemPrompt` alongside the preset's `systemRole`. |
| `suggestedPrompts` | `(string \| { prompt, response?, action? })[]` | preset's | Overrides the preset's suggested-prompt chip row. |
| `tools` | `string[]` | preset's | Overrides the preset's tool allowlist (metadata — see [Persona presets](#persona-presets)). |

Initial agent resolution order: `agent` → persisted choice (if `persistAgent`) →
`DEFAULT_AGENT_ID` → first agent in the roster.

### Properties

| Member | Type | Description |
|--------|------|-------------|
| `currentAgent` | `RiggedAgent \| null` | The live agent (read-only). |
| `currentPreset` | `PagePersonaPreset \| undefined` | The resolved persona preset (read-only). |
| `context` | `Record<string,string>` | Sanitized host context, read-only copy. |
| `systemPrompt` | `string` | `preset.systemRole` + sanitized `context`, composed. Never sent anywhere by this package. |
| `suggestedPrompts` | `{prompt,response,action}[]` | Resolved, normalized chip list. |
| `tools` | `string[]` | Resolved tool allowlist (metadata). |

### Methods

```ts
narrate(text: string, opts?: { interrupt?: boolean }): Promise<void>
```
Speak a single line. Resolves when it ends, is skipped, or cancelled. Un-collapses
the agent first. `interrupt: true` cuts off current speech.

```ts
narratePage(opts?: { selector?: string; greet?: boolean }): Promise<void>
```
Walk the page and narrate it segment by segment, highlighting and scrolling to
each. `selector` scopes the segments; `greet: true` speaks the agent's persona
line first. See [segment selection](#segment-selection).

```ts
stop(): void
```
Cancel any narration/walk in progress and clear highlights.

```ts
setAgent(id: AgentId): Promise<void>
```
Swap to another rigged agent live — loads its GLB, reframes, adopts its voice and
accent. Rejects (and emits `error`) if the GLB fails to load.

```ts
mute(on?: boolean): void
collapse(on?: boolean): void
openPicker(): void
closePicker(): void
```

```ts
setContext(context: Record<string, unknown>): void
```
Re-sanitize and replace the host context (e.g. once a wallet connects
after load), re-composing `.systemPrompt`.

```ts
on(event: PageAgentEvent, cb: (payload) => void): this   // chainable
off(event: PageAgentEvent, cb: (payload) => void): this
dispose(): void                                          // tear everything down
```

### Events

| Event | Payload | Fires when |
|-------|---------|-----------|
| `ready` | `RiggedAgent` | The initial agent has loaded. |
| `agentchange` | `RiggedAgent` | An agent's GLB finished loading (initial + each swap). |
| `state` | `'idle' \| 'speaking'` | Speech starts/stops. |
| `caption` | `string \| null` | Caption text updates (`null` when cleared). |
| `segment` | `{ text: string, el: Element }` | A page-walk segment begins. |
| `error` | `Error` | Load or speech-synthesis failure. |

```js
guide.on('agentchange', (a) => console.log('now:', a.name))
     .on('error', (e) => report(e));
```

### `mount(config?)`

```ts
import { mount } from '@three-ws/page-agent';
const guide = mount({ agent: 'nova' });   // === new PageAgent(config)
```

---

## HTML: `<page-agent>` element

Registered automatically on import (browser only). Invisible itself — the agent
docks to the corner.

```html
<script type="module">import '@three-ws/page-agent';</script>
<page-agent avatar="nova" position="bottom-right" auto-narrate></page-agent>
```

### Attributes

| Attribute | Maps to | Notes |
|-----------|---------|-------|
| `avatar` | `agent` | Initial agent id. |
| `agents` | `agents` | Comma-separated allow-list. |
| `position` | `position` | Dock corner. |
| `asset-base` | `assetBase` | GLB host. |
| `greeting` | `greeting` | Spoken on load. |
| `auto-narrate` | `autoNarrate` | Present → tour; value → selector. |
| `muted` | `muted` | Boolean (presence). |
| `collapsed` | `collapsed` | Boolean (presence). |
| `no-picker` | `picker: false` | Boolean (presence). |
| `no-controls` | `controls: false` | Boolean (presence). |
| `preset` | `preset` | Persona preset id. See [Persona presets](#persona-presets). |
| `context` | `context` | JSON object string, sanitized. Malformed JSON is ignored (never throws). |

### Methods & events

The element proxies `narrate`, `narratePage`, `stop`, `setAgent`, `mute`,
`collapse`, `openPicker`, `setContext`, and exposes `.controller` (the
`PageAgent`), `.currentAgent`, `.currentPreset`, `.systemPrompt`, and
`.tools`. Controller events are re-dispatched as bubbling DOM `CustomEvent`s,
prefixed `page-agent:`:

```js
const el = document.querySelector('page-agent');
el.addEventListener('page-agent:segment', (e) => console.log(e.detail.text));
el.setAgent('vera');
```

### `registerElement(tag?)`

```ts
import { registerElement } from '@three-ws/page-agent';
registerElement('site-guide');     // register under a custom tag → returns the tag
```

---

## HTML attributes

For the `data-page-agent` auto-init script.

Add `data-page-agent` to a `<script>` loading the global build and it auto-starts
from its `data-*` attributes (the first such script wins; idempotent).

| Attribute | Effect |
|-----------|--------|
| `data-page-agent` | **Required** — enables auto-init. |
| `data-avatar` | Initial agent id. |
| `data-agents` | Comma-separated allow-list. |
| `data-position` | Dock corner. |
| `data-asset-base` | GLB host. |
| `data-greeting` | Line spoken on load. |
| `data-auto-narrate` | Present → tour; `data-auto-narrate=".sel"` → selector. |
| `data-muted` | Start muted (presence). |
| `data-collapsed` | Start collapsed (presence). |
| `data-no-picker` | Hide picker (presence). |
| `data-no-controls` | Hide control bar (presence). |
| `data-preset` | Persona preset id. See [Persona presets](#persona-presets). |
| `data-context` | JSON object string, sanitized. Malformed JSON is ignored. |

The instance is available as `window.__threeWsPageAgent`.

---

## Persona presets

`preset="…"` resolves a full persona in one attribute — greeting, a
`systemRole` brief, four suggested-prompt chips, and a `tools` allowlist.
Explicit `greeting` / `suggested-prompts` / `tools` attributes/config always
win over the preset's defaults (decision: presets supply *defaults*, not
overrides).

```ts
import { PRESETS, PRESET_IDS, resolvePreset, sanitizeContext, buildSystemPrompt } from '@three-ws/page-agent';
// or: import { PRESETS } from '@three-ws/page-agent/presets';
```

| Export | Type | Description |
|--------|------|-------------|
| `PRESETS` | `Record<string, PagePersonaPreset>` | The five shipped personas, keyed by id. |
| `PRESET_IDS` | `readonly string[]` | `['guide', 'shop-assistant', 'defi-advisor', 'onboarding-coach', 'support']`. |
| `resolvePreset(id?)` | `PagePersonaPreset \| undefined` | Lookup by id; `undefined` for unknown/empty (never throws). |
| `sanitizeContext(input)` | `Record<string,string>` | String-values-only, ~1KB cap, 20-key cap, backtick/newline-stripped. |
| `buildSystemPrompt(preset, context)` | `string` | `preset.systemRole` + a fenced `[Host page context]` block. |

| preset | for | tools (metadata) |
|--------|-----|-------------------|
| `guide` | Narrates the host page end to end — the default, made explicit | `page-narration`, `page-navigation` |
| `shop-assistant` | Product questions and purchase guidance | `product-catalog`, `shipping-info`, `page-navigation` |
| `defi-advisor` | Explains yield, holdings, and risk on DeFi pages (the Sperax deployment) | `protocol-analytics`, `portfolio-readonly`, `risk-disclosures` |
| `onboarding-coach` | Walks new users through signup and first steps | `onboarding-flow`, `page-navigation` |
| `support` | FAQ-style help with escalation phrasing | `faq-search`, `escalation` |

```html
<page-agent avatar="vera" preset="defi-advisor" context='{"page":"vault-detail"}'></page-agent>
```

**No chat backend here, by design.** `page-agent` is a client-side TTS
narrator — there's no `fetch()` in this package. `greeting` and
`suggestedPrompts` are fully real (spoken via the Web Speech API, no network
round-trip faked); `tools` is a documented allowlist for a **paired** LLM
chat backend (e.g. `<agent-3d chat>` on the same page) and is metadata only
today — there's no live request path in this package to enforce it against.
Read `guide.systemPrompt` / `guide.tools` if you wire one up.

See the [README's Persona presets section](../README.md#persona-presets) for
a full runnable example per preset.

---

## Catalog

```ts
import {
  AGENTS, DEFAULT_AGENT_ID, DEFAULT_ASSET_BASE,
  getAgent, agentUrl, filterAgents,
} from '@three-ws/page-agent';
```

| Export | Type | Description |
|--------|------|-------------|
| `AGENTS` | `RiggedAgent[]` | The full rigged roster. |
| `DEFAULT_AGENT_ID` | `string` | `'sol'`. |
| `DEFAULT_ASSET_BASE` | `string` | `'https://three.ws/avatars/'`. |
| `getAgent(id)` | `RiggedAgent \| undefined` | Lookup by id. |
| `agentUrl(agent, assetBase?)` | `string` | Resolve a GLB URL (`agent.url` wins over base+file). |
| `filterAgents(q?)` | `RiggedAgent[]` | Filter by `{ style, presents, lipsync, ids }`. |

```js
filterAgents({ style: 'realistic', lipsync: 'viseme' });
filterAgents({ ids: ['sol', 'nova'] });
```

### The roster

| id | name | style | presents | lipsync | framing |
|----|------|-------|----------|---------|---------|
| `sol` | Sol | realistic | neutral | viseme | bust |
| `nova` | Nova | stylized | female | viseme | upper |
| `vera` | Vera | realistic | female | viseme | bust |
| `atlas` | Atlas | realistic | male | viseme | bust |
| `echo` | Echo | stylized | neutral | viseme | upper |
| `lumen` | Lumen | stylized | neutral | jaw | upper |
| `kai` | Kai | robot | robot | animation | full |
| `mira` | Mira | stylized | female | animation | full |
| `pax` | Pax | stylized | neutral | animation | full |

---

## Building blocks

Full walkthrough: [Building blocks guide](./guide-building-blocks.md).

### `AvatarStage`

```ts
new AvatarStage(container: HTMLElement, opts?: { background?: string })
  .load(url: string, opts?: { framing?: 'bust'|'upper'|'full' }): Promise<gltf|null>
  .setSpeaking(on: boolean): void
  .onFrame(fn: (dt: number, nowMs: number) => void): () => void   // returns unsub
  .morph: { mode:'arkit'|'jaw', map } | null
  .dispose(): void
```

### `SpeechNarrator`

```ts
new SpeechNarrator(stage: AvatarStage, opts?: {
  muted?: boolean,
  onState?: (s: 'idle'|'speaking') => void,
  onCaption?: (text: string|null) => void,
  onError?: (e: Error) => void,
})
  .setAgent(agent: RiggedAgent): void
  .setMuted(muted: boolean): void
  .speak(text: string, opts?: { interrupt?: boolean }): Promise<void>   // queues
  .cancel(): void
  .speaking: boolean
  .dispose(): void
```

### `AvatarPicker`

```ts
new AvatarPicker(agents: RiggedAgent[], opts: {
  onSelect: (id: string) => void,
  getCurrent: () => string | undefined,
  title?: string,
  subtitle?: string,
})
  .mount(parent?: HTMLElement): void
  .open(): void
  .close(): void
  .isOpen: boolean
  .dispose(): void

AvatarPicker.restore(): string | null    // persisted id
AvatarPicker.persist(id: string): void
```

---

## Lipsync engine

```ts
import { createLipsync, buildMorphMap, estimateDurationMs } from '@three-ws/page-agent';
```

```ts
buildMorphMap(root: Object3D): { mode: 'arkit'|'jaw', map: Map } | null
```
Scan a model for viseme/jaw morph targets. `null` → no mouth morphs.

```ts
createLipsync(text: string, morph: ReturnType<typeof buildMorphMap> | null, opts?: { rate?: number }): {
  tick(nowMs: number): void;   // call each frame
  stop(): void;                // zero influences, mark done
  readonly done: boolean;
  readonly totalMs: number;
}
```
A deterministic text→viseme timeline. With `morph === null` it's a safe no-op
(`totalMs === 0`). `rate > 1` speeds the mouth to match faster TTS.

```ts
estimateDurationMs(text: string): number   // rough natural duration, ms
```

---

## Page content extraction

```ts
import { collectSegments } from '@three-ws/page-agent';
collectSegments(selector?: string): { el: Element, text: string }[]
```

The function `narratePage()` uses to build its segment list. Useful if you want
to compute or preview the tour yourself.

### Segment selection

`narratePage()` / `collectSegments()` pick the **first** non-empty source:

1. Elements matching `selector` (if provided).
2. `[data-narrate]` elements — text from the attribute, else the element's text;
   ordered by `data-narrate-order` when present.
3. Fallback: visible headings (`main`/`article` `h1`–`h3`, then page `h1`/`h2`)
   each joined with their following lead `<p>`, in document order.

Spoken text is whitespace-collapsed and capped at **600 chars**; the heading
fallback yields at most **12** segments.

---

## Types

```ts
type AgentId     = string;
type Position    = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
type LipsyncMode = 'viseme' | 'jaw' | 'animation';
type Presents    = 'female' | 'male' | 'neutral' | 'robot';
type AvatarStyle = 'realistic' | 'stylized' | 'robot';
type Framing     = 'bust' | 'upper' | 'full';
type PageAgentEvent = 'ready' | 'agentchange' | 'state' | 'caption' | 'segment' | 'error';

interface VoiceProfile { lang?: string; pitch?: number; rate?: number; match?: string[]; }

interface SuggestedPrompt { prompt: string; response: string; action?: 'narrate' | 'tour'; }

interface PagePersonaPreset {
  id: string; name: string; description: string;
  greeting: string; systemRole: string;
  suggestedPrompts: SuggestedPrompt[]; tools: string[];
}

interface RiggedAgent {
  id: AgentId; name: string; tagline: string; persona: string;
  file: string; url?: string;
  rig: 'rpm' | 'mixamo' | 'studio';
  lipsync: LipsyncMode; presents: Presents; style: AvatarStyle; framing: Framing;
  voice: VoiceProfile; accent: string;
}
```

`PageAgentConfig` matches the [config table](#config) above.

---

[← Docs home](./README.md) · [Recipes →](./recipes.md) ·
[Troubleshooting →](./troubleshooting.md)
