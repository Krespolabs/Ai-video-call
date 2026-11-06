# Prompt 20 — Spatial MCP standard · evidence

Open spec + reference renderer + conformance validator + adopting tools. Coin-clean, reusable across both stores.

## Deliverables

| Piece | Path |
|---|---|
| Spec (v0.1, CC0) | `specs/SPATIAL_MCP.md` |
| Validator + builder (pure core) | `api/_lib/spatial-mcp.js` |
| Validator MCP tool | `validate_spatial_response` — `api/_mcp3d/tools/spatial.js` (free, read-only), registered in `api/_mcp3d/catalog.js` |
| Reference renderer | `public/spatial-mcp/spatial-renderer.js` + demo `public/spatial-mcp/index.html` → `/spatial-mcp` |
| Adoption doc | `docs/spatial-mcp.md` |
| Tests | `tests/spatial-mcp.test.js` (22 cases) |

## Tools emitting conformant artifacts

Under `structuredContent.spatial`:
- Free 3D Studio (`/api/mcp-studio`): `forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`.
- Paid 3D Studio (`/api/mcp-3d`): `preview_3d`.

## Verification (all run)

- **All 3D tools emit conformant artifacts** — `tests/spatial-mcp.test.js` drives the real free-studio dispatcher (mocked `/api/forge`) for all six tools and validates the emitted `structuredContent.spatial`. 22/22 green.
- **Portability** — `artifact-foreign-transformed.json` is a foreign `{ model_url, thumbnail, name }` result run through a 6-line adapter; it validates `true` and the reference renderer renders it beside a native artifact at `/spatial-mcp`.
- **Rejects malformed payloads with actionable messages** — `validate-rejected.json`: a payload missing `spatialMcpVersion` with an `http` glbUrl returns `valid:false` and 2 errors naming `spatialMcpVersion` and `scene.glbUrl` + the fix.
- **Coin-clean** — the spec, renderer, and validator contain no payment/coin surface (test `carries no payment/coin surface`; grep of `api/_lib/spatial-mcp.js`, `public/spatial-mcp/*`, `specs/SPATIAL_MCP.md` for `x402|wallet|usdc|token|coin|price|mint` is clean).

## Files here

- `artifact-native.json` — a conformant artifact as three.ws emits it.
- `artifact-foreign-transformed.json` — a foreign result transformed to conformant (portability proof).
- `validate-conformant.json` — validator output for a good artifact (`valid:true`).
- `validate-rejected.json` — validator output for a broken artifact (`valid:false` + actionable errors).
