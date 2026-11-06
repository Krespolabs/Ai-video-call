## Context

[`src/shared/pulse-format.js`](https://github.com/nirholas/three.ws/blob/main/src/shared/pulse-format.js) is the single source of truth for how numbers render on the [Money Pulse](https://three.ws/pulse) page (`src/pulse.js`) and the viability panels (`src/shared/viability-panels.js`). Its compact formatters pick a unit by comparing the raw value to a threshold, then round. When rounding pushes a value up past the threshold, the label comes out in the wrong unit:

Verified on `main`:

```bash
node --input-type=module -e "
import { fmtUsd, fmtThree } from './src/shared/pulse-format.js';
console.log(fmtUsd(9.999), fmtUsd(999.6), fmtUsd(999999), fmtThree(999.6), fmtThree(999950));
"
```

```
$10.00 $1000 $1000.0k 1000 1000.0k
```

| Call | Today | Expected |
|---|---|---|
| `fmtUsd(9.999)` | `$10.00` | `$10` (the format every other value from 10 to 999 uses) |
| `fmtUsd(999.6)` | `$1000` | `$1.0k` |
| `fmtUsd(999999)` | `$1000.0k` | a millions label, for example `$1.0M` (there is no millions branch today) |
| `fmtThree(999.6)` | `1000` | `1.0k` |
| `fmtThree(999950)` | `1000.0k` | `1.00M` |

On a live counter these are exactly the numbers that appear right before a milestone, which is when people screenshot the page.

There are no tests for this file today.

## What to change

Fix `fmtUsd` and `fmtThree` so the unit is chosen after rounding (or so the thresholds account for it), and give `fmtUsd` a millions branch. Keep every other output unchanged. Add `tests/pulse-format.test.js` covering the boundaries.

`fmtSol`, `fmtNum`, `fmtPct`, and the HTML helpers are out of scope for this issue.

## Acceptance criteria

- [ ] Every "Expected" value in the table holds.
- [ ] Values well inside each band are unchanged (for example `fmtUsd(0)`, `fmtUsd(5)`, `fmtUsd(42)`, `fmtUsd(12345)`, `fmtThree(0.5)`, `fmtThree(42)`, `fmtThree(340)`, `fmtThree(12400)`, `fmtThree(1200000)`), locked in by tests.
- [ ] Each boundary (10, 1,000, 1,000,000) is tested just below, at, and just above.
- [ ] Non-numbers and negatives render the same as today.

## How to test

```bash
npx vitest run tests/pulse-format.test.js
npm test
npm run dev
```

With the dev server running, open http://localhost:3000/pulse and confirm the counters still render.

Good first issue: pure functions, a visible result, and a clear table of right answers. Comment "taking this" before you start.
