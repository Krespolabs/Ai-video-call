// IRL device-credential transport.
//
// The anonymous device token is a BEARER credential: presenting it reads a
// device's full pin location history and interaction inbox. It must therefore
// never sit in a URL query string — query strings land in platform access logs,
// browser history, and (for any cross-origin sub-resource) the `Referer` header,
// none of which our in-app `redactUrl()` scrub can reach.
//
// The durable fix (epic IRL-Hardening H2) is to carry the token in a request
// HEADER (`x-irl-device`) for reads, or the POST/DELETE body for mutations. This
// helper centralises the read so every endpoint resolves the token the same way:
//
//   header  →  body  →  query (DEPRECATED fallback, one release only)
//
// `cors()` in api/_lib/http.js advertises `x-irl-device` in
// access-control-allow-headers so the preflight passes cross-origin.

// Resolve the anonymous device token from a request, preferring the header so it
// never has to ride in a logged/cached URL. Falls back to the POST/DELETE body,
// then — for one deprecation window — the legacy `?deviceToken=` query param,
// warning (without logging the value) when that path is hit so we can confirm
// in-flight clients have migrated before removing it.
//
// Returns a non-empty string, or null. An empty/whitespace token resolves to
// null so it can never become a SQL clause that matches another owner's NULL or
// empty-token rows.
export function readDeviceToken(req) {
	const fromHeader = pickHeader(req?.headers?.['x-irl-device']);
	if (fromHeader) return fromHeader;

	const fromBody = normalize(req?.body?.deviceToken);
	if (fromBody) return fromBody;

	const fromQuery = normalize(req?.query?.deviceToken);
	if (fromQuery) {
		// One-line deprecation signal — never the token value itself.
		console.warn('[irl] deprecated deviceToken query param — migrate to x-irl-device header');
		return fromQuery;
	}
	return null;
}

function pickHeader(raw) {
	// Node lower-cases header keys; a repeated header arrives as an array.
	const v = Array.isArray(raw) ? raw[0] : raw;
	return normalize(v);
}

function normalize(v) {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length ? t : null;
}
