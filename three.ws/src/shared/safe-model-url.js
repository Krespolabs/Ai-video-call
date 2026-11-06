import { isDecentralizedURI } from '../ipfs.js';

// Hosts we trust to serve avatar/model GLBs. Anchored so only these domains
// (and their subdomains) match — never a substring like `three.ws.evil.com`.
export const TRUSTED_ASSET_HOST_RE = /(^|\.)(three\.ws|r2\.dev|mypinata\.cloud|pinata\.cloud|ipfs\.io|dweb\.link|arweave\.net)$/i;

/**
 * Whether a `?model=` URL is safe to fetch/render under the three.ws origin.
 * Accepts same-origin relative paths, decentralized URIs (ipfs:// / ar://),
 * and https URLs on the trusted asset hosts. Everything else is rejected so a
 * three.ws page can't be turned into an open relay that renders attacker GLBs.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isSafeQueryModelUrl(raw) {
	if (!raw || typeof raw !== 'string') return false;
	if (raw.startsWith('/') && !raw.startsWith('//')) return true; // same-origin relative
	if (isDecentralizedURI(raw)) return true; // ipfs:// / ar://
	try {
		const u = new URL(raw, location.origin);
		if (u.origin === location.origin) return true;
		if (u.protocol !== 'https:') return false;
		if (u.hostname === 'storage.googleapis.com') return true;
		return TRUSTED_ASSET_HOST_RE.test(u.hostname);
	} catch {
		return false;
	}
}
