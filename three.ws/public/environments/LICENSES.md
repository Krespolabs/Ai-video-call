# Walk environments — asset provenance

Every file under `public/environments/` is **authored and owned by three.ws**
and dedicated to the public domain under **CC0 1.0 Universal**. None of it is a
third-party download; all of it is generated deterministically by
[`scripts/build-walk-environments.mjs`](../../scripts/build-walk-environments.mjs)
(`npm run build:walk-environments`).

| Asset | What it is | How it's made |
|---|---|---|
| `<name>/scene.glb` | The environment's scenery (trees, towers, palms, pedestals, desks…) as a real glTF binary. | Procedural box/cylinder/cone/sphere geometry composed via `@gltf-transform/core`. Every top-level node sits at its ground `(x, 0, z)`; the page snaps each onto the terrain at load. |
| `<name>/env.hdr` | Equirectangular Radiance RGBE environment map for image-based lighting (PBR reflections). | A per-environment analytic sky model (gradient + sun disc + neon/softbox glow lobes), packed to Greg Ward RGBE. |
| `<name>/preview.jpg` | 256×256 HUD picker thumbnail. | Composed from the sky gradient + ground band + themed SVG silhouettes, rasterised with `sharp`. |
| `index.json` | Manifest: terrain tint, sky gradient, light rig, env-map intensity, static colliders, dynamic-prop counts. | Emitted alongside the assets so the runtime contract and the geometry can never drift. |

`void` is fully procedural — it ships no GLB and no HDR; its grid floor and dark
IBL wash are built at runtime in
[`src/walk-environments.js`](../../src/walk-environments.js).

## Upgrading fidelity later

These are intentionally clean, low-poly worlds — the contract, not the ceiling.
To replace any environment with a richer artist asset, drop a new
`scene.glb` / `env.hdr` into its directory (keep top-level prop nodes at their
ground position so terrain-snapping still works, and keep the collider list in
`index.json` aligned), then re-run the preview/manifest build. Update this file
with the new asset's license if it is not CC0.
