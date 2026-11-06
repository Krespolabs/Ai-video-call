## Context

Before a user's 3D model is uploaded, the browser checks its 12-byte GLB header so a misnamed JPEG is rejected instantly instead of after a full upload. That check is `isValidGlbMagic` in [`src/shared/glb-magic.js`](https://github.com/nirholas/three.ws/blob/main/src/shared/glb-magic.js), used by [`src/create-agent.js`](https://github.com/nirholas/three.ws/blob/main/src/create-agent.js) and [`src/agent-edit.js`](https://github.com/nirholas/three.ws/blob/main/src/agent-edit.js).

Its header comment says it "mirrors the server-side `isValidGlbHeader()` in `api/_lib/glb-inspect.js`" and that it checks "that the declared file length field is at least the minimum GLB size". **It does not check the length field at all.** It checks the magic bytes and the version, then returns `true`.

The server version in [`api/_lib/glb-inspect.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/glb-inspect.js) does more:

```js
const declaredLen = view.getUint32(8, true);
if (declaredLen > buf.length || declaredLen < 20) return false;
```

So a truncated or corrupted GLB (a valid 12-byte header whose declared length is larger than the file, or smaller than 20) passes the browser check and is only rejected after it has been uploaded. The two checks are supposed to agree, and today they do not. There is also no test for `glb-magic.js`.

Verified on `main`:

```bash
node --input-type=module -e "
import { isValidGlbMagic } from './src/shared/glb-magic.js';
const header = (declared) => { const b = new ArrayBuffer(12); const v = new DataView(b); v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, declared, true); return b; };
console.log('declares 5000 bytes, file is 12:', await isValidGlbMagic(new File([header(5000)], 'a.glb')));
console.log('declares 8 bytes:', await isValidGlbMagic(new File([header(8)], 'a.glb')));
"
```

```
declares 5000 bytes, file is 12: true
declares 8 bytes: true
```

Both should be `false`, because the server rejects both.

## What to change

In `isValidGlbMagic`, read the declared length (little-endian `uint32` at byte offset 8) and return `false` when it is below 20 or larger than `file.size`, matching the server. Keep reading only the first 12 bytes; the point of the function is that it never buffers the whole file. Make the header comment match what the code does.

Add `tests/glb-magic.test.js`. Node 20 and later have a global `File`, so tests can build headers the way the probe above does.

## Acceptance criteria

- [ ] A valid header whose declared length equals the file size returns `true`.
- [ ] Declared length larger than `file.size` returns `false`.
- [ ] Declared length below 20 returns `false`.
- [ ] Wrong magic, version 1, a file under 12 bytes, and a missing file all return `false` (these already do; lock them in).
- [ ] The function still reads only `file.slice(0, 12)`.
- [ ] The header comment describes exactly the checks the code performs.

## How to test

```bash
npx vitest run tests/glb-magic.test.js
npm test
```

Good first issue: a small, well-bounded correctness fix with a clear reference implementation next door. Comment "taking this" before you start.
