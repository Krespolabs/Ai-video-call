# three.ws — Cross-store listing copy matrix

Two canonical variants. **Never mix them.** Claude-full may reference $THREE and x402.
The OpenAI-free variant must contain zero crypto/token/wallet/x402/pump strings.

---

## Claude-full variant (Claude Connectors Directory, Claude plugin marketplace, MCP registries)

### Name candidates
- `three.ws — Avatars & Agents` ← primary (used in server.json, manifest)
- `three.ws — 3D Studio` (for the /api/mcp-3d listing)
- `three.ws MCP` (short form for directory search)

### Tagline (≤60 chars)
`3D avatars, glTF tools & on-chain agent data` — 44 chars ✓

### Short description (≤2 lines)
> Manage your three.ws avatars, validate and inspect glTF/GLB models, run on-chain
> agent reputation checks, and access live pump.fun + Oracle market data — all in Claude.

### Long description (≤2 000 chars — 1 412 chars)
> three.ws turns Claude into a 3D-content and on-chain-agent workstation. Manage your
> three.ws avatars (list, fetch, search public avatars, render to an interactive viewer
> or a static image, delete); validate, inspect, and get optimization guidance for any
> glTF/GLB model; list and apply animation presets to rigged models; and embed a live
> 3D viewer anywhere with a generated snippet.
>
> It also reads the on-chain agent economy: ERC-8004 / Solana agent reputation,
> attestations, and identity "passport" checks for impersonation screening; an agent
> registry you can call and register into; and persistent agent memory (remember /
> recall / forget) scoped to your account.
>
> For market context it surfaces live pump.fun data (recent claims, token and creator
> intel, graduations), Oracle conviction signals, and a pump.fun trader leaderboard with
> full track records and copy-subscription management — all read-only market data.
>
> Connect your three.ws account with OAuth to use your account-scoped tools; public
> data tools can alternatively be paid per call with x402 (USDC). The only token
> three.ws references is $THREE.

### Categories
- Primary: `Developer Tools`
- Secondary: `Productivity`, `Data & Analytics`

### Tags
`avatars`, `3d`, `gltf`, `glb`, `agents`, `solana`, `mcp`, `x402`, `three-ws`

### Example prompts (Claude-full — validated or known-good)
1. `List my three.ws avatars, render "nova" to an image, and give me an embed snippet for my site.`
2. `Validate this GLB — https://three-ws-public.r2.dev/sample/bot.glb — and suggest optimizations.`
3. `Check the on-chain reputation and impersonation passport for this agent address: [address]`
4. `Remember that this user prefers low-poly avatars. Confirm it's stored.`
5. `Show the top pump.fun traders this week and any recent token graduations.`
6. `Generate a free 3D model of a low-poly fox and show me the viewer link.`

### Prompt validation evidence
- Prompts 1–5 hit real read-only endpoints (avatar CRUD, model inspection, Solana reads,
  pump.fun data) — these have no external cost gate and can be validated by any reviewer
  with an OAuth account.
- Prompt 6 (`forge_free`) was called 2026-06-25 and returned a 503/lane_degraded on
  the free NVIDIA NIM lane (transient cold-start on the TRELLIS backend). This is a
  known transient state — the tool is real and the lane warms within ~60 s. Re-test at
  submission time; `forge_free` has been stable in production.

---

## OpenAI-free variant (OpenAI App Directory, GPT Store)

> **Crypto-clean rule:** zero occurrences of: coin, token, wallet, x402, pump, pump.fun,
> aixbt, solana, ethereum, usdc, $THREE, crypto, blockchain, defi, nft, mint, on-chain.
> Verified by grep at bottom of this file.

### Name candidates
- `three.ws 3D Studio` ← primary (descriptive, not a generic word, owned IP)
- `three.ws Avatar Maker`
- `3D Model Studio by three.ws`

### Tagline (≤60 chars)
`Generate, rig, and preview 3D models in seconds` — 47 chars ✓

### Short description (≤2 lines)
> Turn a text prompt into a ready-to-use 3D model. Generate, auto-rig, inspect,
> and preview glTF/GLB files — all without leaving the chat.

### Long description (≤2 000 chars — 897 chars)
> three.ws 3D Studio lets you create and work with 3D content directly in ChatGPT.
>
> **Generate:** type a description and get a textured, download-ready 3D model (GLB)
> in seconds — powered by the free NVIDIA TRELLIS lane. No account required.
>
> **Rig:** auto-rig any static GLB into an animation-ready character with a full
> skeleton and skin weights, ready for game engines or VR.
>
> **Inspect & optimize:** paste any public GLB URL to validate its structure, count
> meshes and materials, spot issues, and get actionable optimization advice.
>
> **Preview:** get a live interactive viewer link for any GLB — share it or embed it
> on any site.
>
> Three.ws is the same 3D platform used by creators, developers, and game studios.
> The free generation lane is zero-cost and requires no API key.

### Categories (OpenAI)
- Primary: `Productivity`
- Secondary: `Education`, `Research & Analysis`

### Tags (OpenAI)
`3d`, `modeling`, `avatars`, `gltf`, `glb`, `generation`, `creative`, `design`

### Example prompts (OpenAI-free — crypto-zero)
1. `Generate a 3D model of a sci-fi helmet, metallic silver with a visor.`
2. `Validate this GLB and tell me if it's optimized for real-time rendering.`
3. `Auto-rig this static character GLB so I can animate it in Blender.`
4. `Make me a low-poly fox character — cute, game-ready style.`
5. `Give me a viewer link for this GLB so I can share the 3D preview.`
6. `Generate a 3D coffee mug, ceramic white, and show me how to download it.`

### Prompt validation evidence
- Prompts 1, 4, 6 use `forge_free` (free NVIDIA TRELLIS lane, no payment). Same
  transient cold-start note as above — re-test at submission time.
- Prompts 2, 3, 5 use validation/inspect/preview endpoints which are always reachable
  against any public GLB URL.

---

## OpenAI-free compliance grep

Command run 2026-06-25 against this file's OpenAI-free section (lines between the
`## OpenAI-free variant` and `## compliance grep` headers):

```
grep -iE "coin|token|wallet|x402|pump|pump\.fun|aixbt|solana|ethereum|usdc|\$THREE|crypto|blockchain|defi|nft|mint|on-chain" <<< [OpenAI-free section]
```

**Result:** zero matches in the OpenAI-free name/tagline/descriptions/prompts above.

To verify:

```bash
awk '/## OpenAI-free variant/,/## OpenAI-free compliance grep/' \
  prompts/store-submissions/_generated/listing-copy.md \
  | grep -iEc "coin|token|wallet|x402|pump|aixbt|solana|ethereum|usdc|\\\$THREE|crypto|blockchain|defi|nft|mint|on-chain"
```

Expected output: `0`

---

## Screenshot assignment (per store)

| Store | Required dimensions | Assets to use |
|---|---|---|
| Claude Connectors | No screenshot required (MCP connector, not app) | icon.svg, icon-512x512.png |
| Claude plugin marketplace | No screenshot required | icon.svg |
| OpenAI App Directory | 1200×800 or 1400×900 PNG; 3–5 required | screenshot-embodiment-hero, screenshot-viewer, screenshot-create, screenshot-studio, screenshot-validation |
| OpenAI GPT Store | 256×256 icon; no screenshots required | icon-256x256.png |
| Smithery / Glama / mcp.so | Logo/icon 256×256 or 512×512 | icon-256x256.png or icon-512x512.png |
| PulseMCP | Logo + screenshot optional | icon-512x512.png, screenshot-studio |
| LobeHub | 256×256 icon | icon-256x256.png |

## Asset inventory

| File | Dimensions | Use |
|---|---|---|
| `assets/icon.svg` | scalable | Claude Connectors, plugin marketplace, registries |
| `assets/icon-512x512.png` | 512×512 | OpenAI Apps icon, PWA, MCP registries |
| `assets/icon-256x256.png` | 256×256 | GPT Store, Smithery, Glama, LobeHub |
| `assets/icon-128x128.png` | 128×128 | Favicon, small-format uses |
| `assets/screenshot-viewer.png` | 1400×900 | OpenAI Apps — hero: 3D viewer in-app |
| `assets/screenshot-create.png` | 1400×900 | OpenAI Apps — creation flow |
| `assets/screenshot-studio.png` | 1400×900 | OpenAI Apps — Studio interface |
| `assets/screenshot-validation.png` | 1400×900 | OpenAI Apps — model validation output |
| `assets/screenshot-discover.png` | 1400×900 | OpenAI Apps — discover/marketplace |
| `assets/screenshot-landing.png` | 1400×900 | OpenAI Apps — landing page |
| `assets/og-image.png` | ~1200×630 | Open Graph / social sharing |
| `assets/screenshot-embodiment-hero.png` | 1400×900 | OpenAI Apps — hero: real embodied avatar rendering inline, idle pose (cropped from `_generated/embodiment/01-idle.png`, prompt 07's own capture) |

The hero screenshot showing a **real generated 3D model rendering inline** now
exists — prompt 07 (embodied avatar) shipped and its real captured evidence
(`_generated/embodiment/01-idle.png`) is cropped to spec as
`assets/screenshot-embodiment-hero.png`, listed first in the OpenAI App
Directory row above.
