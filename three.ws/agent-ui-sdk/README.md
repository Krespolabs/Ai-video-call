<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/agent-ui</h1>

<p align="center"><strong>Drop a 3D avatar onto a transparent overlay and let it react to your DOM — clicks, inputs, and navigation.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/agent-ui"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/agent-ui?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/agent-ui"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/agent-ui?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/agent-ui?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/agent-ui?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#imperative-api">Imperative API</a> ·
  <a href="#declarative-attributes">Declarative</a> ·
  <a href="#options">Options</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/agent-ui` packages the avatar-overlay runtime from the [three.ws](https://three.ws)
> demos into a small Three.js SDK. The avatar lives on a transparent, fullscreen
> canvas above your DOM and is anchored to real elements: it can stand on a card,
> fall onto a heading, walk over to focus an input, cover its eyes when you type a
> password, or run off-screen before a navigation. One `createAgentUI()` call gets
> you a handle with imperative methods; one `agent.scan()` call wires up declarative
> `data-agent-*` attributes with no per-element JS.

## Install

```bash
npm install @three-ws/agent-ui three
```

`three` (`>=0.150.0`) is a peer dependency so your bundler de-dupes it. The package
ships source ESM (`@three-ws/agent-ui`) plus a prebuilt bundle subpath
(`@three-ws/agent-ui/bundle`).

## Quick start

```html
<canvas></canvas>
<div id="hero">three.ws</div>

<script type="module">
  import { createAgentUI } from '@three-ws/agent-ui';

  const agent = await createAgentUI({
    avatar: '/avatars/cz.glb',
    clipsBase: '/animations/clips/',
    clips: ['idle', 'walk', 'falling'],
  });

  const hero = document.getElementById('hero');
  agent.fallOnto(hero, {
    onLand: () => {
      agent.fx.dust(hero);
      agent.fx.impactPulse(hero);
    },
  });

  agent.scan(); // wires any data-agent-action attributes in the page
</script>
```

`createAgentUI(options)` resolves once the GLB and clip JSONs load and the avatar is
in scene. The resolved handle exposes the Three.js objects (`renderer`, `scene`,
`camera`, `canvas`, `avatar`), animation control, movement/posing behaviors, FX
helpers, and lifecycle (`whenReady`, `destroy`).

## Imperative API

```js
// Animation — clips are loaded from `clipsBase`
agent.play('idle', { loop: true });
agent.play('covereyes', { loop: false, hold: true });
agent.clip('walk');        // → clip duration in seconds (0 if not loaded)
agent.currentClip;         // → name of the clip currently playing

// Movement & posing
agent.standOn(formCard, { anchor: 'top-center' }); // park without traversal
agent.walkTo(emailInput);                          // walk-cycle over to an element
agent.fallOnto(heading, { duration: 1.4 });        // drop in from above
agent.runOff('right');                             // walk off-screen
agent.interceptNavigation(homeLink, { direction: 'right', delay: 1100 });
agent.lookAt(450);   // turn yaw toward a screen-X (pixels)
agent.faceFront();

// FX
const stopShadow = agent.fx.proximityShadow(heading); // returns a disposer
agent.fx.dust(buttonEl);
agent.fx.impactPulse(buttonEl);

// Utilities
agent.worldOfElement(el, { anchor: 'center' }); // DOM rect → world-space target
const pick = agent.pickFrom(['nod', 'shrug', 'wave']); // non-repeating picker
agent.whenReady((a) => { /* runs now or on ready */ });
agent.destroy(); // cancels RAF, unlocks root motion, tears down the renderer
```

Anchors accepted by `standOn` / `walkTo` / `worldOfElement`: `top-left`,
`top-right`, `top-center` (default), `center`, `bottom-center`, `left-of`,
`right-of`.

The same behavior functions are exported standalone for advanced compositions:
`createRenderer`, `loadAvatar`, `createAnimator`, `lockRootMotion`, `worldOfElement`,
`moveTo`, `lookAtScreenX`, `faceFront`, `walkTo`, `standOn`, `fallOnto`, `runOff`,
`interceptNavigation`, `createRandomPicker`, `caretScreenX`, `startCaretTracking`,
`dust`, `impactPulse`, `proximityShadow`, `scan`.

## Declarative attributes

Mark up the page, call `agent.scan()` once. It returns a cleanup function that
removes every listener it added.

```html
<div class="card" data-agent-action="stand-on"></div>

<input data-agent-action="track-typing" />
<input data-agent-action="privacy-mode" type="password" />

<a href="/" data-agent-action="navigate-on-click" data-agent-direction="right">Home</a>
<button data-agent-action="react-on-click" data-agent-clip="celebrate">Subscribe</button>
```

| `data-agent-action` | Behavior |
|---|---|
| `stand-on` | Park the avatar above this element on ready. |
| `track-typing` | On focus, walk to the input, play `lookdown`, then follow the caret with yaw. |
| `privacy-mode` | On focus, walk to the input, play `covereyes` once and hold; play `idle` on blur. |
| `navigate-on-click` | Intercept the click, run off-screen, then follow `href`. |
| `react-on-click` | Play `data-agent-clip` once on click. |

Optional modifiers: `data-agent-direction` (`left`/`right`), `data-agent-clip`,
`data-agent-anchor`, `data-agent-delay` (ms), `data-agent-loop` (`true`/`false`),
`data-agent-hold` (`true`/`false`).

## Options

```ts
createAgentUI({
  avatar: '/avatars/cz.glb',        // GLB URL (you host it)
  clipsBase: '/animations/clips/',  // base path for clip JSONs
  clips: ['idle', 'walk', 'lookdown', 'covereyes', 'falling', 'celebrate'],
  subclips: {
    // Trim a long Mixamo clip down to just the settle frames
    covereyes: { start: 0, end: 48, fps: 30 },
  },
  container: undefined, // defaults to document.body
  canvas: undefined,    // explicit canvas; otherwise one is created
  pixelsPerUnit: 120,
  zIndex: 999,
  parallax: true,
  crossfade: 0.3,
  lights: true,
});
```

## Notes

- **Assets are yours.** The SDK does not bundle the avatar GLB or animation JSONs — point it at whatever you host. Every URL is configurable; the three.ws CDN paths are only the defaults.
- **Three.js is a peer dep** so your bundler de-dupes it. Works with Three r150+.
- **No animation-library dependency.** All tweens use built-in `requestAnimationFrame` easings.
- **Root motion is locked** automatically so walk-cycle hip translation doesn't drift the avatar off-screen.

## Requirements

- Node `>=18`.
- Peer dependency: `three` `>=0.150.0`.
- A GLB avatar and clip JSONs you host (no bundled assets).

## Related packages

- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — the full avatar SDK with `<agent-3d>`, lipsync, and an avatar creator.
- [`@three-ws/viewer-presets`](https://www.npmjs.com/package/@three-ws/viewer-presets) — tuned light rig, floor reflection, and bloom configs.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0 — see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
