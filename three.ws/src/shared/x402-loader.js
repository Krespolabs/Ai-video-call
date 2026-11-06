// Shared x402 SDK loader — load the payment widget on demand, once.
//
// public/x402.js is an ES module that freezes window.X402 on evaluation. It
// lives at the site root in dev (Vite serves /public) and prod (copied to /),
// but most pages don't ship it in their HTML — callers that take payments
// (cosmetics shop, NPC services, intel kiosk) load it the first time a player
// transacts: one network fetch, cached for the session.
//
// Loaded via an injected <script type="module"> rather than a dynamic
// import(): Vite refuses to serve /public assets through the module transform
// pipeline (dev 500s with "can only be referenced via HTML tags"), while a
// script tag works identically in dev and prod. A module script's load event
// fires after evaluation, so window.X402 is frozen by the time we resolve.
//
// Resolves with window.X402 (pay() ready); rejects if the script can't load.
// A failed load clears the in-flight promise so a later interaction retries.

let x402Loading = null;

export function ensureX402() {
	if (typeof window !== 'undefined' && window.X402 && typeof window.X402.pay === 'function') {
		return Promise.resolve(window.X402);
	}
	if (!x402Loading) {
		x402Loading = new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.type = 'module';
			script.src = '/x402.js';
			script.addEventListener('load', resolve, { once: true });
			script.addEventListener('error', () => reject(new Error('Payment library failed to load.')), { once: true });
			document.head.appendChild(script);
		}).then(() => {
			if (!window.X402 || typeof window.X402.pay !== 'function') {
				throw new Error('Payment library failed to load.');
			}
			return window.X402;
		}).catch((err) => {
			x402Loading = null; // let a later interaction retry a transient failure
			throw err;
		});
	}
	return x402Loading;
}
