# three.ws satellite repositories

This directory is the canonical source for focused repositories exported from the three.ws
monorepo. Each child is complete, independently testable, and intentionally smaller than the
main repository.

| Satellite | Purpose | Export target |
| --- | --- | --- |
| [`agent-starter`](./agent-starter) | One-click Codespaces introduction to an animated 3D agent | `nirholas/threews-agent-starter` |
| [`glb-quality-gate`](./glb-quality-gate) | GitHub Action that reviews changed GLB files in pull requests | `nirholas/glb-quality-gate` |
| [`oracle-desk`](./oracle-desk) | Autonomous pump.fun trading desk on the three.ws Oracle: six desks, a head that fires losing strategy seats, paper by default | `nirholas/oracle-desk` |

Build every publishable tree with:

```bash
npm run export:growth-satellites
```

The exporter is one-way. The monorepo is always the source of truth; exported repositories
must never be merged back into it.
