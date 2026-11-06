// GET /api/v1/x — discovery front door.
//
// The real dispatch logic (billing-lane selection, provider/endpoint lookup,
// and the zero-segment discovery response) all live in the catch-all route
// ./[...slug].js, which already handles a zero-segment request correctly
// (`if (slug.length === 0) return json(res, 200, { data: { providers: … } })`).
//
// The file-based router (server/index.mjs `resolveApi`) only checks for a
// sibling `index.js` when a request has zero path segments past `/api/v1/x`
// — a bare `[...slug].js` (Vercel's single-bracket "catch-all", not the
// double-bracket "optional catch-all") never matches zero segments. Without
// this file, `GET /api/v1/x` — the exact URL documented in docs/api-
// reference.md, advertised as `base_url` in providerCatalog()'s discovery
// payload, and fetched by the /crypto-api storefront — 404s in production.
// This file exists purely to make the router find the handler that was
// already correct; no logic is duplicated.
export { default } from './[...slug].js';
