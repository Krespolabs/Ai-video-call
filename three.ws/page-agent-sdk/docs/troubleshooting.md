# Troubleshooting & FAQ 🟢

The usual snags, why they happen, and the fix.

---

## Speech

### I see the avatar mouthing words but hear nothing

Almost always the browser's **autoplay policy**: audio is blocked until the
visitor interacts with the page. This is by design — not a bug. The avatar
mouths the words and captions show regardless, so the guide never looks frozen;
sound starts on the first click/tap (or when they press ▶).

Nothing to fix. If you want to be explicit, prompt for a click before narrating.

### Still silent after interacting

- **Firefox** ships with no speech-synthesis voices by default on many systems,
  so `speechSynthesis` may produce no audio. The visual lipsync + captions still
  run. Chrome, Edge, and Safari have built-in voices.
- **Voices load late.** On some platforms the voice list is empty for a moment
  after load; the narrator listens for `voiceschanged` and picks a voice when it
  arrives. The first line may use a default voice.
- **Muted.** Check you didn't start with `muted` / `data-muted`.

### The wrong voice is used

Browsers expose different voices. Each agent lists preferred voice-name
substrings (`voice.match`) and a language; the narrator picks the first installed
match, then any voice for the language, then the first local voice. You can't
guarantee a specific voice across machines — it depends on what the visitor has
installed.

### Speech cuts off / overlaps

Use `{ interrupt: true }` to replace current speech, or `guide.stop()` before a
new line. Multiple `narrate()` calls **queue** by default and play in order.

---

## Avatar / rendering

### The avatar doesn't appear

1. **WebGL.** The page needs a WebGL-capable browser/GPU. Check the console for
   context-creation errors.
2. **GLB failed to load.** Listen for it:
   ```js
   guide.on('error', (e) => console.error(e));
   ```
   A `Failed to load agent "…"` error means the GLB URL 404'd or was blocked.
3. **`assetBase` / `url`.** If you're self-hosting, confirm the file exists at
   `assetBase + agent.file` and is reachable.

### CORS errors loading a self-hosted GLB

Serve the model with permissive CORS headers (`Access-Control-Allow-Origin`).
GLBs are fetched cross-origin by three.js; without CORS the load fails. A CDN or
same-origin host avoids this.

### Two agents / duplicate canvases

Only run **one** `PageAgent` (or `AvatarStage`) at a time — each holds a WebGL
context, and browsers cap how many exist. On SPA navigation or hot reload, call
`guide.dispose()` before constructing a new one. The `<page-agent>` element
disposes automatically on disconnect.

### The avatar is a frozen statue

You're loading an **unrigged** mesh through the building blocks. The runtime needs
a skeleton (and ideally morph targets) to animate — see
[Custom avatars](./guide-custom-avatars.md). The built-in catalog is all rigged.

### Reduced motion

Under `prefers-reduced-motion: reduce` the avatar softens idle motion and blinks,
and page scrolling during a tour is instant. That's intentional.

---

## Build / bundler

### `Cannot find module 'three'` or `Failed to resolve import "three"`

The ESM build (`dist/page-agent.mjs`) leaves `three` **external** — install it:

```bash
npm install @three-ws/page-agent three
```

If you don't want to manage `three`, use the CDN global build instead, which
inlines it:

```html
<script src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
        data-page-agent defer></script>
```

### `[page-agent] requires a browser environment` (SSR)

`PageAgent` was constructed on the server. Build it in a client-only hook
(`useEffect`, `onMounted`, `onMount`) or behind a dynamic import with SSR
disabled. See [Framework integration](./guide-frameworks.md).

### Importing `/global` from a CDN 404s

CDNs resolve real file paths, not the package's export aliases. Use the explicit
dist path:

```
https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js
```

(or the bare `https://unpkg.com/@three-ws/page-agent`, which resolves the
package's `unpkg` field to the same file).

### Multiple versions of `three`

If your app already bundles `three`, make sure there's a single copy
(deduped) — two `three` instances can cause "is not an instance of" errors. The
ESM build's external `three` shares your app's copy, which is what you want.

---

## TypeScript

### `<page-agent>` errors in JSX

Declare the intrinsic element once — see
[Framework integration → TypeScript](./guide-frameworks.md#typescript).

### Types aren't found

They ship with the package (`types/index.d.ts`, referenced by `package.json`
`types`). No `@types/...` install needed. If your `tsconfig` uses
`"moduleResolution": "node"`, switch to `"bundler"` or `"node16"` so the
`exports`/`types` map resolves.

---

## FAQ

**Does it need a backend or API key?** No. Rendering, speech, and lipsync are all
client-side. You bring the copy.

**Is the visitor's voice/mic used?** No microphone, no audio capture, no network
calls for speech. Lipsync is computed from the text.

**How big is it?** The ESM build leaves `three` external and tree-shakes. The
global CDN build inlines three for a single-tag drop-in (larger, but one request
and zero setup).

**Can I use my own avatar?** Yes — see [Custom avatars](./guide-custom-avatars.md).
It must be skeleton-rigged; for lipsync include ARKit visemes or a
`jawOpen`/`mouthOpen` morph.

**Can visitors turn it off?** They can mute, minimize (collapse), and close the
control bar's affordances. You can also gate it on a preference — see
[Recipes](./recipes.md#respect-a-reducedisable-preference).

**Which browsers?** Any modern WebGL browser renders the avatar. Speech audio is
best in Chrome/Edge/Safari (Firefox often lacks voices). Everything degrades to
visual lipsync + captions.

---

Still stuck? [Open an issue](https://github.com/nirholas/three.ws/issues) with
your browser, a repro, and any console output.

[← Docs home](./README.md)
