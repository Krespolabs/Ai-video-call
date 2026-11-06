# Embodiment — live agent body evidence

Captured from the live embodiment embed (`/embodiment/embed`) driving the shared
`EmbodimentStage` — the same engine an MCP `persona_say` result renders inline in
ChatGPT/Claude. Regenerate with:

```
npm run dev                                  # serves the embed + bundles the stage
node scripts/embodiment-evidence.mjs http://localhost:3002
```

The harness fails if any real console error fires; all shots below were captured
with a clean console (dev-only Vite HMR/GPU-perf warnings are filtered).

| Shot | What it proves |
| --- | --- |
| `01-idle.png` | A generated, rigged humanoid (Nova) renders inline and idles — the resting body between turns. |
| `02-joy.png` | `persona_say` with a joyful reply: **Speaking · ☺ joy**, lip-sync active, a celebratory gesture over the idle. |
| `03-sad.png` | A sad reply: **Speaking · ☹ sad** — a distinct, correct expression, body stable (never a splayed/T-pose). |
| `04-angry.png` | An angry reply: **Speaking · ✖ angry** — the third distinct expression. |
| `05-reload-same-body.png` | The SAME persona id reloaded in a brand-new browser context (a fresh session) returns the identical body — continuity. |
| `06-nonhumanoid-fallback.png` | A non-humanoid GLB (a hat, no skeleton) falls back gracefully: it renders with a gentle idle and a designed note — no crash, no frozen T-pose. |

Notes:
- Emotion is detected from the reply text (or set explicitly) and blended onto the
  face + an upper-body gesture; the body always rests on the reliable neutral idle,
  so no rig ever bares a bind pose.
- The demo rig used here (Mixamo X Bot) has no ARKit face morphs, so its expression
  reads through the gesture, the emotion chip, and jaw-driven lip-sync. A rig with
  visemes/morphs drives the face directly via the same path.
- Zero crypto/token/wallet surface anywhere in this feature.
