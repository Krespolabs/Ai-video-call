# Examples

Run these from the **package root** with any static server so the import map can
resolve the unbundled source from `../src`:

```bash
npx serve .
# then open http://localhost:3000/examples/<file>
```

| File | Level | Shows |
|------|-------|-------|
| [`index.html`](./index.html) | 🟢 basic | The full `PageAgent` — drop-in guide, page tour, picker, controls. |
| [`react.jsx`](./react.jsx) | 🟡 medium | A reusable React hook + `<Guide>` component. Needs a bundler. |
| [`headless.html`](./headless.html) | 🔴 advanced | Your own UI on `AvatarStage` + `SpeechNarrator` + `AvatarPicker`. |
| [`custom-avatar.html`](./custom-avatar.html) | 🔴 advanced | Load **your** rigged GLB and inspect its lipsync tier. Accepts `?url=`. |

New to the package? Start with the [docs](../docs/README.md) →
[Getting started](../docs/getting-started.md).
