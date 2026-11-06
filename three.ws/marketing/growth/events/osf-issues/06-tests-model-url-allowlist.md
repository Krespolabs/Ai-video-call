## Context

Pages that accept a `?model=` URL render whatever 3D file that URL points at, under the three.ws origin. [`src/shared/safe-model-url.js`](https://github.com/nirholas/three.ws/blob/main/src/shared/safe-model-url.js) decides which URLs are allowed, so a three.ws page cannot be turned into an open relay that renders an attacker's GLB. It exports `isSafeQueryModelUrl(raw)` and the host allowlist `TRUSTED_ASSET_HOST_RE`, and it is imported by `src/pose-studio.js`, `src/agent-accessories.js`, and `src/avatar-embed.js`.

The allowlist regex is anchored on purpose (its comment says so: "never a substring like `three.ws.evil.com`"). **Nothing tests that.** Remove the `(^|\.)` anchor in a refactor and every test in the repo still passes.

Observed on `main`, with `location.origin` set to `https://three.ws`:

| URL | Result | Why |
|---|---|---|
| `/avatars/a.glb` | `true` | same-origin relative path |
| `//evil.com/a.glb` | `false` | protocol-relative, not same-origin |
| `ipfs://bafy...` | `true` | decentralized URI |
| `https://pub-x.r2.dev/a.glb` | `true` | subdomain of an allowlisted host |
| `https://three.ws.evil.com/a.glb` | `false` | allowlisted name as a prefix of another domain |
| `https://evilr2.dev/a.glb` | `false` | allowlisted name as a suffix without a dot boundary |
| `http://three.ws/a.glb` | `false` | not https and not same-origin |

Reproduce:

```bash
node --input-type=module -e "
globalThis.location = { origin: 'https://three.ws' };
const { isSafeQueryModelUrl: s } = await import('./src/shared/safe-model-url.js');
for (const u of ['/avatars/a.glb', '//evil.com/a.glb', 'ipfs://bafy', 'https://pub-x.r2.dev/a.glb', 'https://three.ws.evil.com/a.glb', 'https://evilr2.dev/a.glb', 'http://three.ws/a.glb']) console.log(u, s(u));
"
```

## What to change

Add `tests/safe-model-url.test.js`. The function reads `location.origin`, and the test suite runs in a Node environment, so stub it with `vi.stubGlobal('location', { origin: 'https://three.ws' })` in a `beforeEach` and restore with `vi.unstubAllGlobals()` afterwards. This issue is tests only: do not change the function or the allowlist.

## Acceptance criteria

- [ ] Every row in the table above is a test case.
- [ ] Look-alike hosts are rejected for at least three allowlisted names (a prefix form like `three.ws.evil.com` and a no-dot suffix form like `evilthree.ws`).
- [ ] Same-origin absolute URLs (`https://three.ws/x.glb`) are accepted.
- [ ] Non-strings, empty strings, and unparseable input (`https://`) return `false`.
- [ ] `ar://` URIs are accepted alongside `ipfs://`.
- [ ] The `location` stub is removed after the tests, so no other test file sees it.

## How to test

```bash
npx vitest run tests/safe-model-url.test.js
npm test
```

Good first issue: a security boundary that deserves a test, and no app knowledge needed. Comment "taking this" before you start.
