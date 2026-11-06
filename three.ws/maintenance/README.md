# Maintenance holding page

A **zero-build** static holding page for `three.ws`, shown while the main app build is
being fixed. It deploys in seconds on any Vercel account because there is nothing to
build — just `index.html` served statically.

## What it is

- Single self-contained `index.html` (no external CSS/JS/fonts/images — all inline).
- On-brand: near-black `#0a0a0a`, violet `#8b5cf6` → blue `#4fc3ff`, Inter/JetBrains Mono.
- `rewrites` send **every** path to the page, so users never hit a raw 404.
- **Auto-recovers:** the page quietly HEAD-probes `/` every 20s and reloads into the
  real app the moment a healthy (non-`x-vercel-error`) response comes back. No manual
  flip needed once the real deploy is green.
- `noindex` so search engines don't cache the holding page.

## Deploy it (new Vercel account) — fastest path

Deploy this folder as its own throwaway project, then point the domain at it.

```bash
cd maintenance
npx vercel deploy --prod --yes        # creates a project from THIS folder only
```

Because `vercel.json` here sets `buildCommand: null` and `outputDirectory: "."`, the
deploy is instant and cannot fail on the app's build.

Then attach the live domain to this temporary project in the Vercel dashboard
(**Project → Settings → Domains → add `three.ws`**), or:

```bash
npx vercel domains add three.ws        # from inside the maintenance project
```

## Switch back

When the real app build passes, re-add `three.ws` to the main project (Vercel moves the
domain back automatically when you assign it there). The holding page's auto-probe will
also reload any still-open browser tabs into the restored app within ~20 seconds.

You can delete the throwaway maintenance project afterward, or keep it around for the
next incident.
