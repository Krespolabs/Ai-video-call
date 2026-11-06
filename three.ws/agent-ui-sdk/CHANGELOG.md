# @three-ws/agent-ui

## 0.2.0

Packaging and documentation release — no API or behavior changes; the public surface is identical to `0.1.0`.

- Completed npm metadata (`homepage`, `repository`, `bugs`, `keywords`, `engines`) so the listing links back to three.ws.
- Rewrote the README to the three.ws house style: branded header, badges, quick start, and a real API reference grounded in the source.

## 0.1.0

Initial release.

- `createAgentUI()` — orthographic overlay canvas, GLB avatar, JSON clip loader, animation mixer with crossfade.
- Behaviors: `play`, `moveTo`, `lookAt`, `walkTo`, `standOn`, `fallOnto`, `runOff`, `interceptNavigation`.
- FX: dust splash, impact pulse, proximity shadow, mouse parallax.
- Caret tracking helper for input typing.
- Declarative scanner: wires `data-agent-action` attributes on elements (`stand-on`, `track-typing`, `privacy-mode`, `navigate-on-click`, `react-on-click`).
