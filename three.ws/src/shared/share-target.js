// Client half of the Web Share Target handoff.
//
// public/share-target-sw.js intercepts the Android share-sheet POST to
// /create/share, parks each shared file in the Cache API under
// `threews-share-target` (`/_share/0`, `/_share/1`, ...) plus the text fields
// under `/_share/meta`, then redirects to /create/selfie?shared=1 or
// /create?shared=glb. The landing page calls `takeSharedFiles()` once to pull
// those files back out as real `File` objects. The read is destructive on
// purpose: a share is consumed exactly once, and a reload never re-attaches it.

const SHARE_CACHE = 'threews-share-target';
const SHARE_KEY_PREFIX = '/_share/';
const SHARE_META_KEY = '/_share/meta';

/**
 * @typedef {object} SharedMeta
 * @property {string} title
 * @property {string} text
 * @property {string} url
 * @property {number} count
 * @property {number} received
 */

/**
 * Drain the share-target cache. Entries older than `maxAgeMs` are discarded
 * (deleted, not returned) so an abandoned share from last week cannot resurface.
 * Safe to call where the Cache API is unavailable: returns no files.
 *
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {Promise<{ files: File[], meta: SharedMeta | null }>}
 */
export async function takeSharedFiles({ maxAgeMs = 10 * 60 * 1000 } = {}) {
	const empty = { files: [], meta: null };
	const native = await takeNativeShare();
	if (native) return native;
	if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') return empty;

	let cache;
	try {
		cache = await caches.open(SHARE_CACHE);
	} catch {
		return empty;
	}

	const now = Date.now();
	const fresh = (res) => {
		const received = Number(res.headers.get('x-share-received'));
		return Number.isFinite(received) && now - received <= maxAgeMs;
	};

	let meta = null;
	const metaRes = await cache.match(SHARE_META_KEY);
	if (metaRes) {
		if (fresh(metaRes)) {
			try {
				meta = await metaRes.json();
			} catch {
				meta = null;
			}
		}
		await cache.delete(SHARE_META_KEY);
	}

	const keys = await cache.keys();
	const indexed = keys
		.map((req) => ({ req, index: shareIndex(req.url) }))
		.filter((k) => k.index !== null)
		.sort((a, b) => a.index - b.index);

	const files = [];
	for (const { req } of indexed) {
		const res = await cache.match(req);
		await cache.delete(req);
		if (!res || !fresh(res)) continue;
		const type = res.headers.get('content-type') || 'application/octet-stream';
		const name = res.headers.get('x-share-filename') || `shared-${files.length}`;
		const received = Number(res.headers.get('x-share-received')) || now;
		// ArrayBuffer parts are understood by every File implementation; a Blob
		// from a foreign realm is not.
		const bytes = await res.arrayBuffer();
		files.push(new File([bytes], name, { type, lastModified: received }));
	}

	return { files, meta };
}

/**
 * The iOS app's half of the hand-off.
 *
 * The iOS WebView runs no service worker, so nothing can intercept a share
 * POST. The app's share extension parks the files in its App Group instead and
 * the app opens this page with `?inbox=<id>` (ios/native/App/ShareExtension/
 * SharedInbox.swift); the `ThreeWsApp` plugin hands them over, once, as base64.
 * Returns null when this is not an app share, so the caller falls through to
 * the Cache API path.
 *
 * @returns {Promise<{ files: File[], meta: SharedMeta | null } | null>}
 */
async function takeNativeShare() {
	if (typeof location === 'undefined') return null;
	const id = new URLSearchParams(location.search).get('inbox');
	const app = globalThis.Capacitor?.Plugins?.ThreeWsApp;
	if (!id || !app || typeof app.takeShare !== 'function') return null;
	let taken;
	try {
		taken = await app.takeShare({ id });
	} catch {
		// Expired, or already opened by an earlier load of this page.
		return { files: [], meta: null };
	}
	const received = Number(taken?.createdAt) || Date.now();
	const files = (Array.isArray(taken?.files) ? taken.files : []).map((f, i) => {
		const bin = atob(String(f.data || ''));
		const bytes = new Uint8Array(bin.length);
		for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
		return new File([bytes], f.name || `shared-${i}`, {
			type: f.type || 'application/octet-stream',
			lastModified: received,
		});
	});
	return {
		files,
		meta: { title: '', text: '', url: '', count: files.length, received },
	};
}

/**
 * @param {string} url
 * @returns {number | null}
 */
function shareIndex(url) {
	let pathname = url;
	try {
		pathname = new URL(url, 'http://localhost').pathname;
	} catch {
		pathname = url;
	}
	if (!pathname.startsWith(SHARE_KEY_PREFIX) || pathname === SHARE_META_KEY) return null;
	const n = Number(pathname.slice(SHARE_KEY_PREFIX.length));
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The `shared` query param the service worker attached on redirect:
 * `'1'` (images or unknown), `'glb'`, `'error'`, or null when not a share.
 * @returns {string | null}
 */
export function sharedIntent() {
	if (typeof location === 'undefined') return null;
	const v = new URLSearchParams(location.search).get('shared');
	return v ? v : null;
}

/**
 * Remove the `shared` param from the address bar without a navigation, so a
 * reload is a plain page load rather than a phantom second share.
 */
export function clearSharedIntent() {
	if (typeof location === 'undefined' || typeof history === 'undefined') return;
	const url = new URL(location.href);
	if (!url.searchParams.has('shared') && !url.searchParams.has('inbox')) return;
	url.searchParams.delete('shared');
	// The iOS app's share id. Consumed already, and meaningless on a reload.
	url.searchParams.delete('inbox');
	history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}
