// Patches colyseus.js after install to harden its IndexedDB storage fallback.
//
// Colyseus stores the room reconnection token in browser storage. It prefers
// window.localStorage, but falls back to an IndexedDB store ('_colyseus_storage')
// when localStorage access throws — which happens when site data is blocked, in
// some privacy modes, and inside Web Workers.
//
// The shipped IndexedDBStorage is fragile in two ways that surface as a flood of
// "Uncaught InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase':
// The database connection is closing.":
//   1. tx() calls db.transaction(...) with no guard, so a connection that is
//      closing/closed during page teardown or a versionchange throws uncaught.
//   2. The open promise only handles onsuccess; an onerror/onblocked open leaves
//      dbPromise pending forever, hanging every read/write that awaits it.
//
// We wrap the transaction in a try/catch (bail to a no-op on failure) and resolve
// the open promise to null on error/blocked so awaiters never hang. Idempotent;
// survives `npm ci` via postinstall.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

const TARGETS = [
	'node_modules/colyseus.js/build/esm/Storage.mjs',
	'node_modules/colyseus.js/build/cjs/Storage.js',
	'node_modules/colyseus.js/lib/Storage.js',
];

const MARKER = 'request.onblocked = () => resolve(null);';

// Resolve the open promise on error/blocked, not just success, so awaiters of
// dbPromise never hang when the database can't be opened. `\1` captures the
// newline + indentation and is reused as the line separator.
const OPEN_RE =
	/(\n[ \t]*)request\.onupgradeneeded = \(\) => request\.result\.createObjectStore\('store'\);\1request\.onsuccess = \(\) => resolve\(request\.result\);/;

// Guard db.transaction(): a closing/closed connection throws synchronously here.
const TX_RE =
	/(\n[ \t]*)const store = db\.transaction\('store', mode\)\.objectStore\('store'\);\1return fn\(store\);/;

// getItem awaits tx(), which now yields undefined when the store is unreachable.
// Guard the null request and resolve the read on error so it never hangs.
const GET_RE =
	/(\n[ \t]*)return new Promise\(\(resolve\) => \{(\n[ \t]*)request\.onsuccess = \(\) => resolve\(request\.result\);/;

let patched = 0;
let skipped = 0;

for (const rel of TARGETS) {
	const file = join(repo, rel);
	if (!existsSync(file)) continue;

	let src = readFileSync(file, 'utf8');
	if (src.includes(MARKER)) {
		skipped++;
		continue;
	}

	const before = src;

	src = src.replace(
		OPEN_RE,
		(_m, lead) =>
			`${lead}request.onupgradeneeded = () => request.result.createObjectStore('store');` +
			`${lead}request.onsuccess = () => resolve(request.result);` +
			`${lead}request.onerror = () => resolve(null);` +
			`${lead}request.onblocked = () => resolve(null);`,
	);

	src = src.replace(
		TX_RE,
		(_m, lead) =>
			`${lead}let store;` +
			`${lead}try { store = db && db.transaction('store', mode).objectStore('store'); }` +
			`${lead}catch (e) { return undefined; }` +
			`${lead}if (!store) return undefined;` +
			`${lead}return fn(store);`,
	);

	src = src.replace(
		GET_RE,
		(_m, lead, inner) =>
			`${lead}if (!request) return null;` +
			`${lead}return new Promise((resolve) => {` +
			`${inner}request.onsuccess = () => resolve(request.result);` +
			`${inner}request.onerror = () => resolve(null);`,
	);

	if (src === before) {
		console.warn(`[fix-colyseus-storage] no match in ${rel} — colyseus internals may have changed`);
		continue;
	}

	writeFileSync(file, src);
	patched++;
}

if (patched > 0) {
	console.log(`[fix-colyseus-storage] hardened IndexedDB storage in ${patched} file(s)`);
} else if (skipped > 0) {
	console.log('[fix-colyseus-storage] already patched');
} else {
	console.log('[fix-colyseus-storage] colyseus.js not installed, skipping');
}
