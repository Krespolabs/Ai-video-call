# Shipping `@three-ws/page-agent`

This package lives inside the three.ws monorepo today and is built to graduate
to its own npm release — and, when there's external demand, its own repo —
without code changes. Follow [STRUCTURE.md → Promotion path](../STRUCTURE.md#promotion-path).

## Publish to npm (from the monorepo)

```bash
cd page-agent-sdk
npm run build          # → dist/page-agent.mjs, dist/page-agent.global.js, dist/page-agent.css
npm test               # catalog + lipsync unit tests
npm publish --access public
```

`prepublishOnly` re-runs the build, so a bare `npm publish` is also safe. The
published tarball ships `dist/`, `src/`, `types/`, `README.md`, and `LICENSE`
(see the `files` field) — verify with:

```bash
npm pack --dry-run
```

## Split into a standalone repo (when external demand justifies it)

The package is self-contained: its only runtime peer is `three`, and it imports
nothing from the parent app. To cut it into its own repo with full history:

```bash
# from the repo root
git subtree split --prefix=page-agent-sdk -b page-agent-split

mkdir ../page-agent && cd ../page-agent
git init && git pull ../three.ws page-agent-split
git remote add origin https://github.com/<org>/page-agent.git
git push -u origin main
```

Then, back in three.ws, either keep the workspace copy or replace it with the
published npm dependency. Until that external need is real, splitting is
premature — keeping it as a workspace costs nothing and keeps releases in lockstep
with the avatar runtime it complements.

## Versioning

Semver, independent of the app version. Bump on every published change; the
`version` field is the source of truth for the npm badge in the README.
