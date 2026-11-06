// Pure ERC-8004 registration-metadata helpers — zero dependencies.
//
// Lives apart from queries.js so light surfaces (marketplace cards, agent
// directories, shared/agent-3d.js) can parse a registration's 3D avatar
// without statically dragging the ethers provider stack into their bundle.
// queries.js re-exports findAvatar3D, so on-chain callers are unaffected.

/**
 * Find an agent's 3D avatar in its registration metadata.
 *
 * The service convention: a `services` entry named `avatar`/`avatar-3d`, or a
 * version starting with `gltf`, or any endpoint that looks like a model file.
 * Falls back to `image` only when it ends in `.glb` or `.gltf` — older files
 * we wrote before the service convention pollute `image` with the GLB URL.
 *
 * @param {any} metadata  Parsed registration JSON
 * @returns {string|null} GLB/GLTF URL (still in raw ipfs://, ar://, https:// form)
 */
export function findAvatar3D(metadata) {
	if (!metadata || typeof metadata !== 'object') return null;

	const services = Array.isArray(metadata.services) ? metadata.services : [];
	for (const svc of services) {
		if (!svc || typeof svc !== 'object') continue;
		const endpoint = String(svc.endpoint || '').trim();
		if (!endpoint) continue;
		const name = String(svc.name || '').toLowerCase();
		const version = String(svc.version || '').toLowerCase();
		if (name === 'avatar' || name === 'avatar-3d') return endpoint;
		if (version.startsWith('gltf')) return endpoint;
		if (/\.(glb|gltf)(\?|#|$)/i.test(endpoint)) return endpoint;
	}

	const img = String(metadata.image || '').trim();
	if (/\.(glb|gltf)(\?|#|$)/i.test(img)) return img;

	return null;
}
