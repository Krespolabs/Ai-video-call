# Unified Service Catalog v1

The canonical, written-once record of every service three.ws sells or gives away, and the wire
formats the storefronts render from it. This is a load-bearing contract: the x402 discovery doc
(`/.well-known/x402.json`) and the OKX.AI listing are both projections of this catalog, and
`tests/service-catalog.test.js` fails the build on any drift between the catalog and what is
actually served.

- **Module:** [`api/_lib/service-catalog/index.js`](../api/_lib/service-catalog/index.js)
- **Descriptors:** [`api/_lib/service-catalog/services/*.js`](../api/_lib/service-catalog/services/)
- **Companion specs:** [okx-agent-payments.md](okx-agent-payments.md) (payment rails),
  x402 bazaar extension (see `api/_lib/x402/bazaar-helpers.js` header)

## Why

x402scan/agentic.market (Base) and OKX.AI (X Layer) are two storefronts over the same backend.
Before this catalog, the listing metadata for one service lived in up to three places: the
endpoint's `BAZAAR` export, a hand-mirrored resource block in `api/wk.js` (~1,400 lines of them),
and the OKX catalog. They drifted — the same route carried different descriptions on different
surfaces. Now a listing is one file; every storefront derives from it.

## The descriptor (one file per paid service)

`api/_lib/service-catalog/services/<slug>.js` default-exports one record:

| Field | Type | Meaning |
|---|---|---|
| `slug` | string | Route basename; `path` must equal `/api/x402/<slug>` |
| `title` | string | Human name without the `three.ws` prefix |
| `category` | string | Browse facet: `3d`, `trust`, `launch`, `market-data`, `payments`, `agent-infra` |
| `useCase` | string | One sentence: which agent, doing what task, uses this |
| `path`, `method` | string | The route and its primary verb |
| `free`, `status` | bool, `'live'\|'deprecated'` | Only `live` entries are projected |
| `priceAtomics` | string | USDC 6-decimal atomics advertised in discovery (env-overridable at the endpoint via `X402_PRICE_<SLUG>`) |
| `acceptsBuilder` | `'standard'\|'cdp-bazaar'\|'permit2-only'` | Which env-aware accepts builder `api/wk.js` applies (Solana+Base / +Arbitrum / Permit2-only-and-omit-without-CDP-creds) |
| `serviceName`, `tags` | string, string[] | Bazaar service metadata (≤32 ASCII chars; ≤5 tags) |
| `description` | string | THE listing description — written once here |
| `input`, `inputSchema` | any, JSON Schema | Example call + params schema for the bazaar discovery extension |
| `outputExample` | any | Response example (older entries are backfilled from `REST_OUTPUT_EXAMPLES` in `api/wk.js`) |
| `bazaar` | object | Optional pre-built `{discoverable, info, schema}` block, passed through verbatim (forge uses this — its shared `forge-listing.js` builds one with the output schema) |
| `storefronts` | string[] | Which storefronts list it (`x402scan` today) |

Descriptors are pure data (plus light imports from an existing single-source listing module,
never from an endpoint handler). The barrel `services/index.js` fixes production bundling and
discovery-doc order: **adding a service = adding the descriptor file + one import row.**

## The API

```js
import {
	getCatalog,          // async → every service: paid x402 + free crypto/3D bundles + OKX rows
	getByStorefront,     // async ('x402scan'|'okx'|'crypto-index'|'3d-index') → filtered view
	toBazaarDiscovery,   // sync — the /api/x402/* resource entries for /.well-known/x402.json
	toOkxCatalog,        // sync — the OKX.AI catalogIndex() payload
} from './api/_lib/service-catalog/index.js';
```

`getCatalog()` merges four sources — the paid descriptors above, `api/_lib/crypto-catalog`
(free Crypto Data API), `api/_lib/3d-catalog` (free 3D API), and `api/_lib/okx-catalog.js`
(OKX 3D Studio rows, read-only) — into one normalized shape:

```json
{
	"slug": "agent-reputation",
	"title": "Cross-chain Agent Reputation",
	"category": "trust",
	"useCase": "…one sentence…",
	"free": false,
	"status": "live",
	"method": "GET",
	"path": "/api/x402/agent-reputation",
	"endpoint": "https://three.ws/api/x402/agent-reputation",
	"price": { "usd": "0.01", "atomics": "10000", "networks": ["solana", "base"] },
	"serviceName": "Cross-chain Agent Reputation",
	"tags": ["reputation", "trust", "cross-chain", "agent", "x402"],
	"description": "…the one listing description…",
	"inputSchema": {},
	"storefronts": ["x402scan"],
	"source": "x402"
}
```

## Storefront projections

**x402scan** — `api/wk.js` calls `toBazaarDiscovery({ origin, acceptsFor, extensionsForAccepts })`
to emit every static `/api/x402/*` resource entry. The env-aware pieces stay in `wk.js`: it
injects `acceptsFor(service, url)` (settleable-rail gating per `acceptsBuilder`; returning `null`
omits the resource, which is how `permit2-paid-demo` disappears without CDP creds) and its
`extensionsForAccepts` normalizer. Everything content-shaped comes from the descriptor.
`node scripts/verify-x402-discovery.mjs` validates the result exactly as before.

**OKX.AI** — `toOkxCatalog()` returns, byte-for-byte, the payload `api/_lib/okx-catalog.js`'s
`catalogIndex()` serves today (asserted by deep-equality in tests), so the OKX stream can point
its module here with zero behavior change. `toOkxCatalog({ include: 'all' })` additionally
projects every live paid x402 service into the same row schema
(`{ id, name, kind, description: { capability, input }, price_usd, endpoint, input_schema }`),
with both description parts clamped to OKX's 200-display-width rule (`displayWidth`, East-Asian
wide glyphs count 2) — ready for a listing expansion beyond the 3D studio.

## Invariants (CI-enforced)

1. Every catalog `x402scan` entry appears in the rendered discovery doc with an **identical**
   description, serviceName, tags, method, and price — and the doc serves no static `/api/x402/*`
   resource the catalog doesn't know about (`tests/service-catalog.test.js`).
2. Every paid `/api/x402/*` route file is either cataloged or explicitly exempted with a reason
   (`tests/api/x402-discovery-parity.test.js`).
3. `toOkxCatalog()` ≡ `catalogIndex()`; projected rows respect the 200-width listing rule.
4. Descriptor hygiene: `path === /api/x402/<slug>`, description ≥ 60 chars, serviceName ≤ 32
   chars, ≤ 5 tags, numeric atomics.

## What stays outside the catalog

- **402-challenge internals** — each endpoint still owns its runtime challenge (its `BAZAAR`
  export, price env override, SIWX/OAuth hints). The catalog owns *listing* copy; storefront
  descriptions and challenge descriptions are converging per-route as endpoints adopt the
  descriptor as their import source (forge already does via `forge-listing.js`).
- **MCP tool rows** — generated from the live tool catalogs (`api/_mcp/catalog.js`,
  `api/_mcp3d/catalog.js`) in `api/wk.js`; they already have a single source.
- **Agent-published listings** (`/api/x402/service/<slug>`) — dynamic rows from
  `agent_paid_services`, cataloged per-listing at render time.
