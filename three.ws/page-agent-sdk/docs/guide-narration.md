# Narrating your page 🟢→🟡

The agent's superpower is *talking visitors through your page*. This guide covers
exactly what it reads, how to control it, and how to script richer tours.

---

## Two kinds of speech

| Method | What it does |
|--------|--------------|
| `narrate(text)` | Speak **one line** you provide. |
| `narratePage()` | **Walk the page** — speak each content segment in order, highlighting and scrolling to each one. |

The script-tag / element `auto-narrate` setting calls `narratePage()` on load.
`greeting` calls `narrate()` once.

---

## What `narratePage()` reads

When the agent tours the page, it builds an ordered list of *segments*. It picks
the **first** of these sources that yields anything:

1. **Your selector** — elements matching the CSS selector you pass
   (`narratePage({ selector: '.tour' })` or `auto-narrate=".tour"`).
2. **`[data-narrate]` elements** — anything you've explicitly tagged.
3. **Heading fallback** — visible `h1`/`h2`/`h3` inside `main`/`article` (then
   page-wide `h1`/`h2`), each paired with its following lead paragraph.

A few rules worth knowing:

- Each segment's spoken text is trimmed and **capped at 600 characters** — keep
  tagged blocks tight, or split them.
- The heading fallback stops after **12 segments** so an untagged page doesn't
  turn into a monologue. Tag your content to go beyond that.
- Hidden elements (`display:none`, `visibility:hidden`, zero-size) are skipped.

---

## Marking up a guided page

### Speak custom copy for an element

Put the words in the attribute. The element's *visible* text stays whatever it
was — `data-narrate` is what gets **spoken**:

```html
<h1 data-narrate="Welcome to the dashboard — here's where your day starts.">
  Dashboard
</h1>
```

### Tag a block to read its own text

An empty `data-narrate` means "read this element's text content":

```html
<section data-narrate>
  Your trial includes every feature. No credit card until you're ready.
</section>
```

### Control the order

By default tagged elements are read in DOM order. Override with
`data-narrate-order` (lower numbers first):

```html
<div data-narrate data-narrate-order="2">Second.</div>
<div data-narrate data-narrate-order="1">First, even though it's lower in the page.</div>
```

### Scope a tour to one region

Pass a selector so only part of the page is toured:

```html
<page-agent avatar="sol" auto-narrate=".product-tour"></page-agent>
```

```js
guide.narratePage({ selector: '.product-tour > *' });
```

---

## Greeting first

`narratePage({ greet: true })` speaks the agent's persona line before the page
walk — a natural "Hi, I'm Nova, let me show you around." `auto-narrate` does this
for you. To use your own greeting instead, call `narrate()` first, then tour:

```js
const guide = new PageAgent({ agent: 'nova' });
guide.on('ready', async () => {
  await guide.narrate('Welcome back, friend!');
  guide.narratePage();           // greet:false — your line already played
});
```

---

## Driving narration from your app

`narrate()` and `narratePage()` return promises that resolve when speech
finishes, so you can sequence them:

```js
await guide.narrate('First, connect your wallet.');
await guide.narrate('Now pick a network.');
guide.narrate('Done — you're ready to trade.');
```

Use `{ interrupt: true }` to cut off whatever's playing and speak immediately
(great for click handlers):

```js
helpButton.addEventListener('click', () => {
  guide.narrate('This saves your draft without publishing.', { interrupt: true });
});
```

Stop everything with `guide.stop()`.

---

## React to the tour with events

```js
guide
  .on('segment', ({ text, el }) => {
    // Fired as each segment begins. `el` is the DOM node being read.
    el.classList.add('being-read');
  })
  .on('caption', (text) => {
    // The live caption string, or null when speech ends.
  })
  .on('state', (s) => {
    document.body.dataset.guideSpeaking = s === 'speaking';
  });
```

On the `<page-agent>` element the same events arrive as DOM `CustomEvent`s:

```js
document.querySelector('page-agent')
  .addEventListener('page-agent:segment', (e) => console.log(e.detail.text));
```

The agent already outlines the current segment in the active guide's accent
color and smooth-scrolls it into view — you usually don't need to do anything for
a polished tour.

---

## Patterns

**A short, scripted welcome instead of a full read:**

```html
<page-agent avatar="sol" greeting="Hey! New here? Hit the tour button anytime."></page-agent>
```

**A "Take the tour" button that starts the walk on demand:**

```js
tourBtn.addEventListener('click', () => guide.narratePage({ greet: true }));
```

**Route-aware narration in a SPA** — re-tour when the view changes:

```js
router.afterEach(() => {
  guide.stop();
  guide.narratePage({ selector: '[data-view] [data-narrate]' });
});
```

More of these in the [Recipes cookbook](./recipes.md).

---

Next: [Framework integration →](./guide-frameworks.md) ·
[API reference →](./api-reference.md)
