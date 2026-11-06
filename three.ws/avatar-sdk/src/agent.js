// Aliased entry for the heavy <agent-3d> runtime.
//
// The full element (chat loop, voice, lipsync, skills, animations) lives in
// the prebuilt monolith at `../dist/index.mjs`. This file exists so that
// consumers can write the clearer subpath import:
//
//   import '@three-ws/avatar/agent';
//
// instead of leaning on the bare-package import for side-effectful element
// registration. The dynamic import keeps the 3.3 MB bundle off the critical
// path for callers that only need `<three-ws-viewer>` from `./viewer`.

let _readyPromise = null;

/**
 * Ensures the <agent-3d> custom element is registered. Returns a Promise
 * that resolves once the monolith finishes loading. Safe to call multiple
 * times — the underlying import is cached.
 *
 * @returns {Promise<void>}
 */
export function ensureAgent3D() {
	if (typeof customElements !== 'undefined' && customElements.get('agent-3d')) {
		return Promise.resolve();
	}
	if (!_readyPromise) {
		_readyPromise = import('../dist/index.mjs').then(() => undefined);
	}
	return _readyPromise;
}

// Fire-and-forget eager load. Importing this module by itself is enough to
// register <agent-3d>; awaiting `ensureAgent3D()` is only needed when the
// caller wants to know exactly when the element is ready.
if (typeof window !== 'undefined') {
	ensureAgent3D().catch((err) => {
		console.error('[@three-ws/avatar/agent] failed to load monolith:', err);
	});
}

export default ensureAgent3D;
