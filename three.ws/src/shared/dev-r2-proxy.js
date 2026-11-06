// Dev-only CORS workaround for R2 public assets.
//
// The bucket's public `*.r2.dev` domain only sends `Access-Control-Allow-Origin`
// for the production three.ws origins. On localhost / Codespaces (`*.github.dev`)
// / Gitpod the browser blocks the cross-origin GLB fetch and the viewer surfaces
// a "Network error". The Vite dev server proxies `/r2-proxy/*` to the bucket
// (see `vite.config.js`), so rewriting r2.dev URLs to that same-origin path lets
// the fetch succeed. This is a no-op in production, where the asset host serves
// the correct CORS headers and the raw URL is used unchanged.

function isDevHost() {
	if (typeof location === 'undefined') return false;
	const h = location.hostname;
	return (
		h === 'localhost' ||
		h === '127.0.0.1' ||
		h.includes('.github.dev') ||
		h.includes('.gitpod.io')
	);
}

/**
 * Rewrite a public r2.dev asset URL to the Vite `/r2-proxy` route in dev so the
 * cross-origin fetch isn't blocked by CORS. Returns the URL unchanged in
 * production or for any non-r2.dev / malformed input.
 * @param {string} url
 * @returns {string}
 */
export function resolveDevR2Url(url) {
	if (!url || typeof url !== 'string') return url;
	if (!isDevHost() || !url.includes('r2.dev')) return url;
	try {
		return '/r2-proxy' + new URL(url).pathname;
	} catch {
		return url;
	}
}
