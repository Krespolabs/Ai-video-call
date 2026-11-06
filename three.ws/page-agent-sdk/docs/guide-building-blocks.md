# Building blocks 🔴

`PageAgent` is a convenience shell. Underneath are four independent, exported
pieces you can compose into something entirely your own — a full-screen kiosk
guide, an in-app onboarding character, a custom-branded picker, a game NPC.

```
AvatarStage      render + animate a rigged GLB (three.js)
SpeechNarrator   speak text (Web Speech) + drive lipsync on the frame loop
AvatarPicker     accessible "choose your guide" modal
lipsync          text → timed visemes → morph influences (the engine)
catalog          the rigged roster + URL/filter helpers
```

Each is documented in the [API reference](./api-reference.md). This guide shows
how they fit together.

---

## Minimal: a stage that talks, with your own UI

No `PageAgent`, no default chrome — just a canvas you place anywhere and a couple
of buttons you style yourself.

```js
import { AvatarStage, SpeechNarrator, agentUrl, getAgent } from '@three-ws/page-agent';

const mountEl = document.querySelector('#guide');     // any sized container
const stage = new AvatarStage(mountEl, { background: 'transparent' });

const agent = getAgent('vera');
await stage.load(agentUrl(agent), { framing: agent.framing });

const narrator = new SpeechNarrator(stage, {
  onState:   (s) => mountEl.dataset.speaking = s === 'speaking',
  onCaption: (text) => (myCaptionEl.textContent = text || ''),
  onError:   (e) => console.warn(e),
});
narrator.setAgent(agent);            // adopt its voice profile

myPlayBtn.onclick  = () => narrator.speak('Hello! This is a fully custom guide.', { interrupt: true });
myStopBtn.onclick  = () => narrator.cancel();
myMuteBtn.onclick  = () => narrator.setMuted(true);   // visual lipsync only

// Clean up when you're done:
// narrator.dispose(); stage.dispose();
```

That's the whole engine. Everything `PageAgent` does is built on exactly this.

---

## `AvatarStage` — the 3D surface

```js
const stage = new AvatarStage(container, { background: 'transparent' | '#0b0c10' });

await stage.load(url, { framing: 'bust' | 'upper' | 'full' });  // swap models live
stage.setSpeaking(true);     // crossfade in the talk clip / body emphasis
stage.morph;                 // the detected morph map (or null) — what lipsync drives
const off = stage.onFrame((dt, nowMs) => { /* runs every render frame */ });
off();                       // unsubscribe
stage.dispose();             // free the WebGL context
```

It auto-frames the model, plays an idle clip (or runs procedural breathing +
blink when the GLB has no clips), handles resize via `ResizeObserver`, and
respects `prefers-reduced-motion`.

### The `onFrame` hook is your extension point

Anything that should react to the avatar in real time hangs off `onFrame`. It's
how `SpeechNarrator` advances lipsync — and you can use it for your own effects:

```js
// Pulse a ring while the agent speaks.
stage.onFrame((dt, nowMs) => {
  ring.style.opacity = stage._speaking ? 0.6 + 0.4 * Math.sin(nowMs / 120) : 0.15;
});
```

---

## `SpeechNarrator` — speech + lipsync

```js
const narrator = new SpeechNarrator(stage, { muted, onState, onCaption, onError });

narrator.setAgent(agent);              // voice profile { lang, pitch, rate, match }
await narrator.speak(text, { interrupt }); // queues; resolves when the line ends
narrator.cancel();                     // stop + clear the queue
narrator.setMuted(true);               // keep lipsync, drop audio
narrator.speaking;                     // boolean
narrator.dispose();
```

Calls to `speak()` **queue** and play in order, each resolving when its line
finishes — so you can script multi-line sequences with `await`. It picks the best
installed system voice from the agent's `voice.match` hints, then `voice.lang`,
then the first local voice. If TTS is unavailable or muted, it still runs the
lipsync timeline for the line's estimated duration so the avatar visibly talks.

---

## `AvatarPicker` — your roster, their choice

Build a picker from any list of agents — the full catalog, a filtered subset, or
your own roster objects:

```js
import { AvatarPicker, filterAgents } from '@three-ws/page-agent';

const roster = filterAgents({ lipsync: 'viseme' });   // e.g. only the best mouths

const picker = new AvatarPicker(roster, {
  onSelect:  (id) => switchTo(id),         // your swap logic
  getCurrent: () => current.id,
  title: 'Meet your concierge',
  subtitle: 'Pick who shows you around.',
});

picker.mount();         // append to <body> (or pass a parent)
myChooseBtn.onclick = () => picker.open();

// Remember the choice across pages, like PageAgent does:
AvatarPicker.persist(id);
const saved = AvatarPicker.restore();   // string id | null
```

It's a focus-trapped, keyboard-navigable modal (arrows to move, Tab to cycle, Esc
to close) with `role="dialog"`/`listbox` semantics — accessibility handled.

---

## The lipsync engine, standalone

Use it on any three.js model, even outside this package:

```js
import { buildMorphMap, createLipsync, estimateDurationMs } from '@three-ws/page-agent';

const morph = buildMorphMap(model);          // { mode:'arkit'|'jaw', map } | null
const ls = createLipsync('hello world', morph, { rate: 1.0 });

// In your render loop:
renderer.setAnimationLoop((t) => { ls.tick(performance.now()); /* … */ });

ls.totalMs;   // length of the viseme timeline
ls.done;      // true once it has fully played
ls.stop();    // zero all influences

estimateDurationMs('some text');   // rough natural duration, for pacing
```

`createLipsync` is deterministic and dependency-free: it tokenizes text into
timed visemes and lerps the matching morph influences each frame. No audio
analysis, no microphone, no network.

---

## Putting it together: a branded onboarding guide

A sketch of a self-contained component that uses the blocks with custom UI,
custom roster, and persisted choice:

```js
import {
  AvatarStage, SpeechNarrator, AvatarPicker,
  filterAgents, getAgent, agentUrl,
} from '@three-ws/page-agent';

export class Onboarding {
  constructor(container) {
    this.stage = new AvatarStage(container, { background: 'transparent' });
    this.narrator = new SpeechNarrator(this.stage, {
      onCaption: (t) => this.caption(t),
    });
    this.roster = filterAgents({ style: 'stylized' });
    this.picker = new AvatarPicker(this.roster, {
      onSelect: (id) => this.use(id),
      getCurrent: () => this.agent?.id,
    });
    this.picker.mount();
    this.use(AvatarPicker.restore() || this.roster[0].id);
  }

  async use(id) {
    this.agent = getAgent(id) || this.roster[0];
    this.narrator.setAgent(this.agent);
    AvatarPicker.persist(this.agent.id);
    await this.stage.load(agentUrl(this.agent), { framing: this.agent.framing });
  }

  async run() {
    await this.narrator.speak(`Hi, I'm ${this.agent.name}. Three quick steps…`);
    await this.narrator.speak('One: connect your account.');
    await this.narrator.speak('Two: pick a workspace. Three: invite your team.');
  }

  caption(text) { /* render your own bubble */ }
  destroy() { this.narrator.dispose(); this.stage.dispose(); this.picker.dispose(); }
}
```

---

## Rules of engagement

- **One WebGL context at a time.** Each `AvatarStage` holds a context; dispose
  before creating another, or you'll exhaust the browser's context budget.
- **Always `dispose()`.** Stage, narrator, and picker each own resources
  (WebGL, speech queue, DOM + listeners).
- **`setAgent` before `speak`.** The narrator needs a voice profile; without one
  it falls back to a default `en-US` voice.

---

Next: [API reference →](./api-reference.md) ·
[Contributing →](../CONTRIBUTING.md)
