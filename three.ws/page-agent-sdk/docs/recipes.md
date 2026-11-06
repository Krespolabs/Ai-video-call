# Recipes 🟡

Copy-paste solutions to common needs. Each assumes a `guide` instance:

```js
import { PageAgent } from '@three-ws/page-agent';
const guide = new PageAgent({ agent: 'sol' });
```

---

## Trigger the tour from a button (not on load)

Leave `autoNarrate` off and start it on demand:

```js
const guide = new PageAgent({ agent: 'nova', collapsed: true });
document.querySelector('#take-tour').addEventListener('click', () => {
  guide.narratePage({ greet: true });
});
```

## "Explain this" buttons

```js
function explain(text) {
  return () => guide.narrate(text, { interrupt: true });
}
document.querySelector('#save').addEventListener('click', explain('This saves a draft — it won't publish.'));
document.querySelector('#publish').addEventListener('click', explain('Publish makes your changes live for everyone.'));
```

## Only tour first-time visitors

```js
if (!localStorage.getItem('toured')) {
  guide.on('ready', () => guide.narratePage({ greet: true }));
  localStorage.setItem('toured', '1');
}
```

## Track which segments visitors actually hear (analytics)

```js
guide.on('segment', ({ text, el }) => {
  analytics.track('guide_segment', { id: el.id || el.tagName, text: text.slice(0, 80) });
});
guide.on('state', (s) => analytics.track('guide_' + s));   // speaking / idle
```

## Sync your UI to the speaking state

```js
guide.on('state', (s) => {
  document.body.classList.toggle('guide-speaking', s === 'speaking');
});
```

```css
.guide-speaking #hero { filter: brightness(0.9); transition: filter .3s; }
```

## Route-aware narration in a SPA

Re-tour the new view whenever the route changes:

```js
function onRouteChange() {
  guide.stop();
  guide.narratePage({ selector: '[data-view]:not([hidden]) [data-narrate]' });
}
// React Router: useEffect on location. Vue Router: router.afterEach. etc.
```

## Multi-language narration

Pick the agent's voice via the catalog's voice profile, and feed translated copy.
The simplest approach is your own strings keyed by `document.documentElement.lang`:

```js
const COPY = {
  en: ['Welcome — let me show you around.', 'Start by connecting your wallet.'],
  es: ['Bienvenido — te muestro el sitio.', 'Empieza conectando tu cartera.'],
};
const lines = COPY[document.documentElement.lang] || COPY.en;
guide.on('ready', async () => { for (const l of lines) await guide.narrate(l); });
```

> Voice availability is the browser's, not ours — the visitor must have a voice
> for that language installed. See [Troubleshooting](./troubleshooting.md#speech).

## Pause speech when the tab is hidden

```js
document.addEventListener('visibilitychange', () => {
  if (document.hidden) guide.stop();
});
```

## Restrict and brand the picker

```js
const guide = new PageAgent({
  agent: 'vera',
  agents: ['vera', 'atlas', 'sol'],   // only these appear in the picker
});
```

For a custom title/subtitle or a filtered roster, build your own picker — see
[Building blocks](./guide-building-blocks.md#avatarpicker--your-roster-their-choice).

## Switch guide based on context

```js
// Match the agent to dark/light mode, locale, persona, A/B bucket, anything.
const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
guide.setAgent(prefersDark ? 'echo' : 'nova');
```

## Respect a "reduce/disable" preference

```js
const wantsQuiet = matchMedia('(prefers-reduced-motion: reduce)').matches
  || localStorage.getItem('guide-off') === '1';

const guide = new PageAgent({
  agent: 'sol',
  muted: wantsQuiet,        // visual only, no audio
  autoNarrate: !wantsQuiet, // don't auto-tour if they opted out
});
```

(The avatar already softens its motion under `prefers-reduced-motion`.)

## Lazy-load the agent (defer the 3D cost)

Only construct it when the visitor is likely to want it — on idle, first scroll,
or a click:

```js
let guide;
function ensureGuide() {
  if (!guide) guide = new PageAgent({ agent: 'nova' });
  return guide;
}
requestIdleCallback(ensureGuide);                 // or:
addEventListener('scroll', ensureGuide, { once: true });
```

With the script tag, the global build is one request; load it `defer` or inject
the tag on interaction.

## Read a form error aloud

```js
form.addEventListener('invalid', (e) => {
  guide.narrate(`Heads up: ${e.target.validationMessage}`, { interrupt: true });
}, true);
```

## Clean teardown (SPA / component unmount)

```js
// React: return () => guide.dispose() from useEffect
// Vue: onBeforeUnmount(() => guide.dispose())
// Vanilla:
window.addEventListener('beforeunload', () => guide.dispose());
```

## Chain narration with awaits

```js
guide.on('ready', async () => {
  await guide.narrate('Three things to know.');
  await guide.narrate('One: it's all client-side.');
  await guide.narrate('Two: pick any guide. Three: it speaks your copy.');
});
```

---

More patterns welcome — send a PR (see [CONTRIBUTING](../CONTRIBUTING.md)).

[← Docs home](./README.md) · [API reference →](./api-reference.md) ·
[Troubleshooting →](./troubleshooting.md)
