# Getting started 🟢

**Goal:** put a talking 3D guide on a web page in about five minutes, with no
build tools, no framework, and no account.

If you can edit an HTML file, you can do this.

---

## Step 1 — Add one line

Open the HTML file for any page and paste this just before the closing
`</body>` tag:

```html
<script
  src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
  data-page-agent
  data-avatar="nova"
  data-auto-narrate
  defer></script>
```

Save it. Open the page in your browser.

That's the whole thing. A rigged avatar named **Nova** docks in the bottom-right
corner and starts talking visitors through your page. A control bar lets them
play/stop, mute, change the guide, or minimize it.

> **What just happened?** The `data-page-agent` attribute tells the script to
> auto-start. The other `data-*` attributes are its settings. The
> `/dist/page-agent.global.js` build bundles everything it needs (including the
> 3D engine), so there's nothing else to install.

### Hear nothing?

Browsers block audio until the visitor interacts with the page (a security rule —
not a bug). Click anywhere, or click ▶ in the control bar. The avatar's mouth
moves and captions show even before audio is allowed, so the guide never looks
frozen. More in [Troubleshooting](./troubleshooting.md#speech).

---

## Step 2 — Make it say what you want

By default the agent reads your page's headings and lead paragraphs. To control
exactly what it says, add a `data-narrate` attribute to any element:

```html
<h1 data-narrate="Welcome! Let me show you around our new pricing page.">
  Pricing
</h1>

<section data-narrate="Every plan includes unlimited projects and email support.">
  …your normal content…
</section>
```

When the agent walks the page, it speaks the `data-narrate` text for those
elements (and highlights each one as it goes). Everything else is skipped. Full
details in [Narrating your page](./guide-narration.md).

---

## Step 3 — Pick a different guide

There are nine rigged guides. Swap `data-avatar` to any id:

| id | who they are |
|----|--------------|
| `sol` | Calm, clear product guide *(default)* |
| `nova` | Upbeat, friendly host |
| `vera` | Composed, professional (British voice) |
| `atlas` | Confident, grounded |
| `echo` | Neutral, even-keeled |
| `lumen` | Minimal studio presenter |
| `kai` | Playful robot sidekick |
| `mira` | Expressive, full-body |
| `pax` | Laid-back explainer |

Want to offer only a few in the visitor's picker? List them:

```html
<script
  src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
  data-page-agent
  data-avatar="sol"
  data-agents="sol,nova,kai"
  data-auto-narrate
  defer></script>
```

---

## Step 4 — Position and behavior

Every setting is a `data-*` attribute. The common ones:

```html
<script
  src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
  data-page-agent
  data-avatar="vera"
  data-position="bottom-left"   <!-- bottom-right | bottom-left | top-right | top-left -->
  data-greeting="Hi there — need a hand finding anything?"
  data-collapsed               <!-- start as a small pill the visitor can open -->
  defer></script>
```

- `data-greeting="…"` — speak a single welcome line on load (instead of touring
  the whole page).
- `data-auto-narrate` — tour the page on load. Add a value to narrate only part
  of it: `data-auto-narrate=".tour-section"` (a CSS selector).
- `data-collapsed` — start minimized as an "Ask a guide" pill.
- `data-muted` — start muted (the avatar still mouths the words + captions show).
- `data-no-picker` — hide the "change guide" button.
- `data-no-controls` — hide the whole control bar.

The complete attribute list is in the [API reference](./api-reference.md#html-attributes).

---

## When you outgrow the script tag

The script tag is perfect for static sites, landing pages, docs, and no-code
builders. The moment you want to *react* to what the agent does — trigger
narration on a button click, log which sections visitors heard, swap the guide
based on the page — move up to the programmatic API:

```html
<script type="module">
  import { PageAgent } from 'https://unpkg.com/@three-ws/page-agent/dist/page-agent.mjs';
  // (note: the .mjs build needs `three` available — see the frameworks guide)

  const guide = new PageAgent({ agent: 'atlas', autoNarrate: true });

  guide.on('segment', ({ text, el }) => {
    console.log('now reading:', text);
  });

  document.querySelector('#help').addEventListener('click', () => {
    guide.narrate('Sure — this button saves your draft.', { interrupt: true });
  });
</script>
```

→ Continue with [Framework integration](./guide-frameworks.md) for a clean setup
in React, Vue, Next, and friends, or the [API reference](./api-reference.md) for
everything `PageAgent` can do.

---

## Cheat sheet

```html
<!-- Simplest possible -->
<script src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
        data-page-agent defer></script>

<!-- Tour the page with a chosen guide, bottom-left -->
<script src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
        data-page-agent data-avatar="nova" data-position="bottom-left"
        data-auto-narrate defer></script>

<!-- Greet only, muted, start collapsed, no picker -->
<script src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
        data-page-agent data-greeting="Welcome back!" data-muted
        data-collapsed data-no-picker defer></script>
```

Next: [Narrating your page →](./guide-narration.md)
