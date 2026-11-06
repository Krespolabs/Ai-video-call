# Contributing to `@three-ws/page-agent`

Thanks for helping build the best rigged 3D guide on the web. This package is
small, dependency-light (only `three`), and fully client-side — which makes it a
great place to contribute, whether you're adding an avatar, sharpening the
lipsync, or shipping a framework adapter.

- **New to the codebase?** Read the [docs](./docs/README.md) first — especially
  [Building blocks](./docs/guide-building-blocks.md), which mirrors the source
  layout.
- **Releasing?** That's [PUBLISHING.md](./PUBLISHING.md), not this file.

---

## Dev setup

The package lives inside the [three.ws](https://three.ws) monorepo but is
self-contained.

```bash
git clone https://github.com/nirholas/three.ws
cd three.ws/page-agent-sdk

npm install          # at the repo root if the workspace needs it
npm run build        # → dist/page-agent.{mjs,global.js,css}
npm test             # catalog + lipsync unit tests
```

### Try your changes live

The example runs the **unbundled source** straight from disk via an import map —
no build step between edits:

```bash
npx serve .          # or any static server at the package root
# open http://localhost:3000/examples/index.html
```

Edit a file in `src/`, refresh, see it. (The example imports `../src/index.js`.)

---

## Project layout

Each module is one focused piece. Keep them that way.

| File | Responsibility |
|------|----------------|
| [`src/index.js`](./src/index.js) | Public entry. Exports, `<page-agent>` registration, `data-page-agent` auto-init. |
| [`src/page-agent.js`](./src/page-agent.js) | The `PageAgent` controller: DOM chrome, drag, narration orchestration, events, `collectSegments`. |
| [`src/stage.js`](./src/stage.js) | `AvatarStage` — three.js scene, GLB load, framing, idle/talk animation, blink. |
| [`src/narrator.js`](./src/narrator.js) | `SpeechNarrator` — Web Speech queue, voice selection, lipsync driving. |
| [`src/lipsync.js`](./src/lipsync.js) | The text→viseme engine: `buildMorphMap`, `createLipsync`, `estimateDurationMs`. |
| [`src/picker.js`](./src/picker.js) | `AvatarPicker` — accessible modal roster grid. |
| [`src/catalog.js`](./src/catalog.js) | The rigged agent roster + `getAgent`/`agentUrl`/`filterAgents`. |
| [`src/element.js`](./src/element.js) | The `<page-agent>` custom element. |
| [`src/styles.js`](./src/styles.js) | The injected stylesheet (also emitted as `dist/page-agent.css`). |
| [`build.mjs`](./build.mjs) | esbuild: ESM (three external) + IIFE global (three inlined) + CSS. |
| [`types/index.d.ts`](./types/index.d.ts) | Hand-written types — **keep in sync with the source**. |

---

## Code style

Match the surrounding code; consistency over preference.

- **Tabs** for indentation; semicolons; single quotes.
- **ES modules**, modern browser APIs, no transpilation assumptions beyond ES2020.
- **No new runtime dependencies.** `three` is the only peer; the engine stays
  dependency-free. (Dev tooling like esbuild is fine.)
- **No mocks, no placeholders, no `TODO`s.** Finish what you start. Real APIs only.
- **Handle errors at the boundary** (load, speech). The graceful-degradation
  contract is sacred: if TTS fails or is muted, the avatar must still visibly
  "talk" and captions must still render — narration never silently stalls.
- **Accessibility is not optional.** Keep ARIA roles, focus management, keyboard
  paths, and `prefers-reduced-motion` support intact.
- Run the linter and tests before opening a PR.

---

## Testing

Unit tests run on Node's built-in test runner (no framework):

```bash
npm test
```

- Tests live in [`test/`](./test/) as `*.test.js`.
- The catalog and lipsync engine are pure and fully testable — **add coverage for
  any change there.** See [`test/catalog.test.js`](./test/catalog.test.js) for the
  shape: every agent must be rigged, lipsync-classified, point at a `.glb`, carry
  a voice profile, and have a valid hex accent — these invariants are enforced.
- DOM-heavy modules (`PageAgent`, `AvatarStage`) aren't unit-tested yet — a
  jsdom-based harness is a welcome contribution (see [ideas](#ideas-worth-building)).

---

## Add an agent to the catalog

The roster is deliberately diverse and **every entry must be rigged** — that's
enforced by tests, not vibes. To add a guide:

1. **Verify the rig.** Your GLB needs a skinned mesh + armature, ideally an idle
   clip and ARKit visemes. Confirm with `buildMorphMap` — see
   [Custom avatars → Verifying your rig](./docs/guide-custom-avatars.md#verifying-your-rig).
2. **Host the GLB** where the catalog's `assetBase` serves it (or give the entry
   an absolute `url`). Don't commit large binaries to the repo without discussing
   it in the issue first.
3. **Add the entry** to [`src/catalog.js`](./src/catalog.js):

   ```js
   {
     id: 'rio',                         // stable, unique, kebab/slug
     name: 'Rio',
     tagline: 'Warm, energetic host',   // one line for the picker card
     persona: "I'm Rio — I'll make this quick and fun.",  // plain language, no jargon
     file: 'rio.glb',                   // filename under assetBase
     rig: 'rpm',                        // 'rpm' | 'mixamo' | 'studio'
     lipsync: 'viseme',                 // 'viseme' | 'jaw' | 'animation'
     presents: 'neutral',               // 'female' | 'male' | 'neutral' | 'robot'
     style: 'stylized',                 // 'realistic' | 'stylized' | 'robot'
     framing: 'upper',                  // 'bust' | 'upper' | 'full'
     voice: { lang: 'en-US', pitch: 1.0, rate: 1.0, match: ['aria', 'jenny'] },
     accent: '#10b981',                 // hex; used for UI chrome + highlights
   }
   ```

4. **Pick the right `lipsync`** for what the rig actually exposes (visemes → jaw →
   animation). Mis-declaring it makes the mouth look wrong.
5. **Tune the voice profile.** `match` is an ordered list of case-insensitive
   substrings tried against installed system voices; add a couple of good
   cross-platform options, plus a `lang`.
6. **Run `npm test`** — the catalog invariants must pass.
7. **Update the roster tables** in [`README.md`](./README.md) and
   [`docs/api-reference.md`](./docs/api-reference.md#the-roster).
8. Add a line to the platform changelog if this ships to users.

Keep the roster diverse: variety of `style`, `presents`, and `lipsync` is a
feature, not clutter.

---

## Improve the lipsync engine

[`src/lipsync.js`](./src/lipsync.js) is a deterministic text→viseme heuristic. It's
intentionally simple and dependency-free, but there's real headroom:

- A proper phoneme dictionary (grapheme→phoneme) for English, then other
  languages, would beat the per-character mapping.
- Coarticulation / blending between adjacent visemes for smoother mouths.
- An optional **audio-driven** mode: analyse `SpeechSynthesis` output (or an
  `<audio>` element) with a Web Audio `AnalyserNode` and drive `jawOpen` from
  amplitude for non-viseme rigs.

Keep the current API (`createLipsync(text, morph, opts).tick/stop/done/totalMs`)
stable, or add a new mode behind it. Cover changes with tests.

---

## Ship a framework adapter

An official React wrapper exists ([`@three-ws/react`](https://www.npmjs.com/package/@three-ws/react)).
Thin, well-typed adapters for **Vue, Svelte, Solid, or Angular** are very welcome —
follow the patterns in [Framework integration](./docs/guide-frameworks.md):
construct in a mount hook, expose `narrate`/`setAgent`, `dispose()` on unmount.

---

## Ideas worth building

Pick one, open an issue to claim it, and have at it. Roughly easy → ambitious:

- **More languages** — externalize the built-in strings (picker title/subtitle,
  the "not much text here" fallback line) and add locales.
- **Persisted position** — remember where a visitor dragged the agent.
- **Theming API** — expose CSS custom properties so hosts can restyle the chrome
  without overriding internals.
- **jsdom test harness** — unit-test `PageAgent` DOM wiring, events, and
  `collectSegments` segment selection.
- **Gesture cues in copy** — let `data-narrate` carry hints (`[wave]`, `[point]`)
  that trigger the talk/gesture clip or aim the agent at the highlighted element.
- **Point at the segment** — rotate/lean the avatar toward the element it's
  currently narrating.
- **Audio-driven lipsync** — the Web Audio analyser mode described above.
- **Ask-me-anything mode** — optional Web Speech *recognition* for voice
  questions, answered by a host-provided callback (bring-your-own LLM; the package
  stays backend-free by default).
- **Streaming narration** — accept an async iterator / stream of text so a
  host-side LLM can narrate as tokens arrive.
- **Bundle diet** — an entry that imports only the three.js bits used, to shrink
  the global build.
- **More rigged agents** — see [above](#add-an-agent-to-the-catalog).

Each of these should preserve the core promises: **client-side, no API key,
accessible, graceful, one WebGL context.**

---

## Pull requests

1. Branch from `main`. Keep the change focused.
2. `npm run build && npm test` — both green.
3. Update docs/types/roster tables touched by your change.
4. Describe the *why*, with a before/after or a short clip for UI/3D changes.
5. By contributing you agree your work is licensed under the project's
   [Apache-2.0](./LICENSE).

Questions or proposals → [open an issue](https://github.com/nirholas/three.ws/issues).
Thank you for making it better. 🙌
