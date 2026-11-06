// ── sanitize-url.js — shared URL scheme guard for rendered markdown links ───
//
// Used wherever LLM/persona/model output is converted to HTML anchors. Blocks
// script-bearing schemes (javascript:, data:, vbscript:) while allowing the
// link shapes that legitimate chat output uses: absolute http(s), site-relative
// paths, in-page anchors, and mailto:. Anything else collapses to '#'.

const SAFE_URL = /^(?:https?:\/\/|\/(?!\/)|#|mailto:)/i;
const UNSAFE_SCHEME = /^\s*(?:javascript|data|vbscript):/i;

export function sanitizeUrl(url) {
	if (typeof url !== 'string') return '#';
	const trimmed = url.trim();
	if (!trimmed || UNSAFE_SCHEME.test(trimmed)) return '#';
	return SAFE_URL.test(trimmed) ? trimmed : '#';
}
