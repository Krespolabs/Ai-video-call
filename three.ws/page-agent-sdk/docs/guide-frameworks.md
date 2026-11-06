# Framework integration 🟡

Clean, production-ready setups for the common stacks. The golden rules:

1. **`PageAgent` needs a browser.** Its constructor throws if `window` is
   undefined, so never construct it during server-side rendering — build it in a
   client-only effect/lifecycle hook.
2. **The ESM build leaves `three` external.** Install it alongside:
   ```bash
   npm install @three-ws/page-agent three
   ```
   (The CDN `dist/page-agent.global.js` build inlines three and needs no install —
   use that for no-code/script-tag setups.)
3. **Always `dispose()` on unmount.** It tears down the WebGL context, speech
   queue, and DOM. One agent at a time.

---

## React

A reusable hook that owns the lifecycle:

```jsx
// usePageAgent.js
import { useEffect, useRef, useState } from 'react';
import { PageAgent } from '@three-ws/page-agent';

export function usePageAgent(config = {}) {
  const ref = useRef(null);
  const [agent, setAgent] = useState(null);

  useEffect(() => {
    const guide = new PageAgent(config);
    ref.current = guide;
    setAgent(guide);
    return () => { guide.dispose(); ref.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);            // construct once; change agents via methods, not re-render

  return agent;
}
```

```jsx
// App.jsx
import { usePageAgent } from './usePageAgent';

export default function App() {
  const guide = usePageAgent({ agent: 'sol', autoNarrate: true });

  return (
    <button onClick={() => guide?.narrate('This is the save button.', { interrupt: true })}>
      Explain this
    </button>
  );
}
```

> Construct **once** in an empty-dependency effect. To change the avatar or
> narration later, call `guide.setAgent(id)` / `guide.narrate(...)` — don't tear
> the instance down and rebuild it on every render.

A published React wrapper also exists: [`@three-ws/react`](https://www.npmjs.com/package/@three-ws/react).

---

## Next.js (App Router)

`PageAgent` is browser-only, so isolate it in a client component and construct it
in `useEffect` (which never runs on the server):

```jsx
// components/Guide.jsx
'use client';
import { useEffect } from 'react';

export default function Guide(props) {
  useEffect(() => {
    let guide;
    // Dynamic import keeps the 3D engine out of the server bundle entirely.
    import('@three-ws/page-agent').then(({ PageAgent }) => {
      guide = new PageAgent({ agent: 'vera', autoNarrate: true, ...props });
    });
    return () => guide?.dispose();
  }, []);
  return null;            // the agent docks itself to <body>
}
```

```jsx
// app/layout.jsx  (or any page)
import Guide from '@/components/Guide';
export default function Layout({ children }) {
  return (<>{children}<Guide /></>);
}
```

Pages Router is the same idea — render `<Guide />` from a component and guard the
constructor behind `useEffect`, or `next/dynamic` with `{ ssr: false }`.

---

## Vue 3

```vue
<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import { PageAgent } from '@three-ws/page-agent';

let guide;
onMounted(() => { guide = new PageAgent({ agent: 'nova', autoNarrate: true }); });
onBeforeUnmount(() => guide?.dispose());

defineExpose({ narrate: (t) => guide?.narrate(t, { interrupt: true }) });
</script>

<template><!-- the agent docks itself; nothing to render here --></template>
```

The `<page-agent>` custom element also works in Vue templates — tell Vue it's a
custom element so it doesn't try to resolve it as a component:

```js
// vite.config.js
export default {
  plugins: [vue({ template: { compilerOptions: {
    isCustomElement: (tag) => tag === 'page-agent',
  }}})],
};
```

```vue
<script setup>import '@three-ws/page-agent';</script>
<template><page-agent avatar="nova" auto-narrate /></template>
```

---

## Svelte

```svelte
<script>
  import { onMount } from 'svelte';
  import { PageAgent } from '@three-ws/page-agent';

  let guide;
  onMount(() => {
    guide = new PageAgent({ agent: 'atlas', autoNarrate: true });
    return () => guide.dispose();   // onMount's return is the cleanup
  });
</script>
```

Custom-element form works too — Svelte passes unknown tags straight through:

```svelte
<script>import '@three-ws/page-agent';</script>
<page-agent avatar="atlas" auto-narrate></page-agent>
```

---

## Astro

Astro ships zero JS by default, so opt in with a client directive. The
script-tag/global build is the simplest path:

```astro
---
// src/components/Guide.astro
---
<script src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
        data-page-agent data-avatar="echo" data-auto-narrate defer is:inline></script>
```

Or, in a framework island (`client:only="react"`), use the React setup above.

---

## SolidJS / Qwik / Angular

The pattern is identical everywhere: **construct in a client-only mount hook,
`dispose()` in cleanup.**

```js
// Solid
import { onMount, onCleanup } from 'solid-js';
onMount(() => { const g = new PageAgent({ agent: 'pax' }); onCleanup(() => g.dispose()); });
```

For Angular, build it in `ngAfterViewInit` and dispose in `ngOnDestroy`; guard
with `isPlatformBrowser` if you use Angular Universal (SSR).

---

## No-code & CMS (Webflow, WordPress, Framer, Shopify, etc.)

Use the script-tag build — it needs no bundler and no `three` install. Paste it
into the platform's "custom code / embed / footer scripts" slot:

```html
<script src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
        data-page-agent data-avatar="nova" data-auto-narrate defer></script>
```

- **WordPress:** a "Custom HTML" block, or your theme's footer, or a headers-and-
  footers plugin.
- **Webflow:** Project Settings → Custom Code → Footer Code.
- **Shopify:** `theme.liquid`, before `</body>`. For the full store treatment —
  a guide that walks the storefront and narrates it alongside this docked
  narrator — follow the step-by-step tutorial:
  [three.ws/tutorials/shopify-store-guide](https://three.ws/tutorials/shopify-store-guide).

Pin a version for stability (e.g. `@three-ws/page-agent@0.1.1/dist/...`) so a
future release can't change behavior under you.

---

## TypeScript

Types ship in the package — no `@types/...` needed. Everything is exported:

```ts
import { PageAgent, type PageAgentConfig, type RiggedAgent } from '@three-ws/page-agent';

const config: PageAgentConfig = { agent: 'sol', autoNarrate: true };
const guide = new PageAgent(config);
const current: RiggedAgent | null = guide.currentAgent;
```

For the `<page-agent>` element in JSX, declare it once:

```ts
// page-agent.d.ts
import type { PageAgentElement } from '@three-ws/page-agent';
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'page-agent': React.DetailedHTMLProps<React.HTMLAttributes<PageAgentElement>, PageAgentElement>
        & { avatar?: string; position?: string; 'auto-narrate'?: boolean | string };
    }
  }
}
```

---

Next: [API reference →](./api-reference.md) ·
[Custom avatars →](./guide-custom-avatars.md) ·
[Recipes →](./recipes.md)
