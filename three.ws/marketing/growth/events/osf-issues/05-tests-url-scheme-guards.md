## Context

Two small functions stand between user- or model-controlled URLs and the page:

- `safeUrl(url, fallback)` in [`src/safe-url.js`](https://github.com/nirholas/three.ws/blob/main/src/safe-url.js) guards `href`, `src`, and CSS `url(...)` sinks. It is imported across the app, for example by `src/communities.js`, `src/marketplace.js`, and `src/app.js`.
- `sanitizeUrl(url)` in [`src/shared/sanitize-url.js`](https://github.com/nirholas/three.ws/blob/main/src/shared/sanitize-url.js) guards links in rendered markdown from LLM, persona, or model output. It is imported by `src/fact-checker-app.js`, `src/economy-live.js`, `src/bounties.js`, and others.

Both exist to stop `javascript:`, `data:`, and `vbscript:` URLs from becoming clickable. **Neither has a single test.** A refactor that loosened either regex would ship green.

They also intentionally differ in a few ways, and those differences are currently documented nowhere but the regexes. Observed on `main`:

| Input | `safeUrl` | `sanitizeUrl` |
|---|---|---|
| `"  javascript:alert(1)"` | `"#"` | `"#"` |
| `"JaVaScRiPt:x"` | `"#"` | `"#"` |
| `"data:text/html,x"` | `"#"` | `"#"` |
| `"//evil.com"` | `"#"` | `"#"` |
| `"#top"` | `"#top"` | `"#top"` |
| `"mailto:a@b.c"` | `"#"` | `"mailto:a@b.c"` |
| `"./a"` | `"./a"` | `"#"` |
| `" https://x.y "` | `" https://x.y "` (returned untrimmed) | `"https://x.y"` (trimmed) |

Reproduce:

```bash
node --input-type=module -e "
import { safeUrl } from './src/safe-url.js';
import { sanitizeUrl } from './src/shared/sanitize-url.js';
for (const u of ['  javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', '//evil.com', '#top', 'mailto:a@b.c', './a', ' https://x.y ']) console.log(JSON.stringify(u), JSON.stringify(safeUrl(u)), JSON.stringify(sanitizeUrl(u)));
"
```

## What to change

Add one test file, `tests/url-scheme-guards.test.js`, with a `describe` block per function and `it.each` tables. This issue is tests only: do not change either function. If a case surprises you, say so in the PR description and a maintainer will decide whether it is a bug.

## Acceptance criteria

- [ ] Script schemes are rejected in every casing and with leading whitespace: `javascript:`, `data:`, `vbscript:`.
- [ ] Protocol-relative `//host` is rejected by both.
- [ ] Allowed shapes are covered for each function: `https://`, `http://`, `/path`, `#anchor`; plus `./` and `../` for `safeUrl`, and `mailto:` for `sanitizeUrl`.
- [ ] Non-strings (`null`, `undefined`, a number, an object) and empty or blank strings return the fallback (`"#"` by default; a custom `fallback` argument for `safeUrl`).
- [ ] The differences in the table above each have a named test, so a future change to them is a deliberate, visible decision.

## How to test

```bash
npx vitest run tests/url-scheme-guards.test.js
npm test
```

Good first issue: no app knowledge needed, and every case is a one-line table row. Comment "taking this" before you start.
