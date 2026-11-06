// Shared helpers for showing an agent's 3D avatar in a real environment.
//
// Every agent has a 3D avatar. If a record carries a custom GLB we use it;
// otherwise we fall back to the baked mannequin (/avatars/mannequin.glb — the
// same figure /pose renders, exported by scripts/bake-mannequin-glb.mjs). That
// makes the "See in 3D" affordance universal: no agent is ever avatar-less, so
// the button is never dead or disabled.

// avatar-meta.js (not queries.js) so this shared helper stays dependency-free —
// importing queries.js would statically drag ethers into every page that shows
// an agent card (marketplace, directories, detail pages).
import { findAvatar3D } from '../erc8004/avatar-meta.js';

// The universal base avatar. Lives in /public, so it's a plain served path.
export const MANNEQUIN_GLB = '/avatars/mannequin.glb';

// $three is the only coin — its community is the world we drop visitors into.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const GLB_RE = /\.(glb|gltf|vrm)(\?|#|$)/i;

// Resolve an agent record (from any surface — marketplace, directory, ERC-8004)
// to a loadable 3D model URL, falling back to the mannequin.
export function agentAvatarGlb(agent) {
	if (!agent) return MANNEQUIN_GLB;

	// Marketplace / avatar-service shapes carry an explicit GLB URL. The single
	// agent GET (GET /api/agents/:id) serves it as `avatar_model_url`, so check
	// that too — otherwise an agent's real avatar silently falls to the mannequin.
	const direct =
		agent.avatar_glb_url ||
		agent.base_model_url ||
		agent.avatar_model_url ||
		agent.glb_url ||
		agent.model_url;
	if (typeof direct === 'string' && GLB_RE.test(direct)) return direct;

	// ERC-8004 on-chain agents expose their model through registration metadata
	// (surfaced as `metadata` on the directory, `rawMetadata` on the detail page).
	try {
		const meta = agent.metadata || agent.rawMetadata;
		if (meta) {
			const fromMeta = findAvatar3D(meta);
			if (fromMeta) return fromMeta;
		}
	} catch {
		/* metadata malformed — fall through to the base avatar */
	}

	// `avatar` is a GLB on the directory but a 2D image elsewhere — use it only
	// when it actually points at a model.
	if (typeof agent.avatar === 'string' && GLB_RE.test(agent.avatar)) return agent.avatar;

	return MANNEQUIN_GLB;
}

// True when the agent ships its own 3D model (vs. wearing the base mannequin).
// Lets surfaces label the CTA precisely ("See in 3D" vs "Preview as mannequin").
export function hasCustomAvatar(agent) {
	return agentAvatarGlb(agent) !== MANNEQUIN_GLB;
}

// Build the /play deep link that drops the agent's avatar into the $three world.
// The avatar rides in `?avatar=` and is shown for the session only — it never
// overwrites the visitor's saved avatar (see play-handoff.getRequestedAvatar).
// Only `coin` (the $three mint) is passed; the world backfills the community's
// real name/symbol/art from the mint, so we never mislabel it with agent data.
export function seeInWorldHref(agent) {
	const q = new URLSearchParams({
		avatar: agentAvatarGlb(agent),
		coin: THREE_MINT,
	});
	return `/play?${q.toString()}`;
}
