// Browser Buffer polyfill. Bundled transitive deps (Metaplex/Anchor discriminators,
// bs58, borsh, spl-token-metadata) reference `Buffer` at module-init time. This
// must execute as a module body BEFORE any of those modules evaluate — so it
// lives in its own file and is imported first by the entry. (If the assignment
// lived inside lib.js's body, `import` hoisting would run every transitive dep
// — including the offending top-level `Buffer.from(...)` calls — before lib.js's
// body ran the polyfill.)
import { Buffer as _NodeBuffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = _NodeBuffer;
