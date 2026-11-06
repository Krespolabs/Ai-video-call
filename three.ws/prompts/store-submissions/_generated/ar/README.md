# Prompt 21 — AR-ready exports · evidence

One-tap "View in your space" for any generated model. Real conversion, device-aware routing, OpenAI-clean, zero crypto.

## Deliverables
| Piece | Path |
|---|---|
| Device-routing pure core | `api/_lib/ar-launch.js` (`detectArTarget`, `planArLaunch`, `buildSceneViewerUrl`, …) |
| Device-aware launch endpoint | `GET /api/ar?src=<glb>&title=` — `api/ar.js` |
| `export_ar` MCP tool | `api/_mcp3d/tools/ar.js` (free, read-only), registered in `api/_mcp3d/catalog.js` |
| In-viewer AR button | `public/viewer.html` (model-viewer `activateAR`, iOS/Android/WebXR) |
| Tests | `tests/ar-export.test.js` (13 cases) |

## Real conversion (no stub)
iOS Quick Look USDZ is generated from the GLB in the launch page by model-viewer's three.js `USDZExporter` — a real conversion, no server-side USD tooling required. Android uses the GLB directly via a Scene Viewer ARCore intent. Desktop falls back to the WebGL viewer.

## Verification (live, against the real route table)
Booted `server/index.mjs` and hit `/api/ar` with real User-Agents:

```
Android UA  → 302  intent://arvr.google.com/scene-viewer/1.2?file=<glb>&mode=ar_preferred
                    #Intent;...package=com.google.ar.core;...S.browser_fallback_url=<viewer>;end;
iOS UA      → 200  launch page (model-viewer → Quick Look)
desktop UA  → 200  launch page (model-viewer + "View in your space", WebGL fallback)
bad input   → 400  clean designed error page (http:// non-glb rejected, not a crash)
missing src → 400  clean error
```

- `export_ar` returns `{ glbUrl, arLaunchUrl, viewerUrl, sceneViewerUrl, spatial }` — see `export_ar-output.json`. The embedded `spatial` artifact is Spatial-MCP conformant with `ar.supported: true` and `ar.launchUrl` populated.
- **OpenAI-clean:** the response has no payment/coin/session/trace/job-id surface (test `response carries no payment/coin/internal-id surface`).
- 13/13 tests green in `tests/ar-export.test.js` (UA classification, boundary rejection, intent-URL build, launch routing, tool output + conformance).

## Files here
- `export_ar-output.json` — real `export_ar` structuredContent (AR links + conformant spatial artifact).
