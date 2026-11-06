/**
 * Rig classifier — the single source of truth for "is this 3D avatar rigged?"
 *
 * A rigged model carries a skeleton (glTF `skins[]` with joints) and can play
 * the platform's animation library; a static mesh has geometry only and must be
 * auto-rigged before it can move. The reconstruct / upload pipeline stamps the
 * signal into `source_meta` when it inspects a delivered GLB
 * (api/_lib/glb-inspect.js): `is_rigged` (boolean) and `skeleton_joint_count`.
 *
 * This module is intentionally dependency-free so it can be imported by the
 * public gallery, the avatar editor, pickers, and any other surface without
 * dragging in the rigging panel's heavier deps. The SQL filter in
 * api/_lib/avatars.js (searchPublicAvatars) mirrors the exact same logic so a
 * server-filtered list and a client-classified badge never disagree.
 */

/** @typedef {'rigged'|'static'|'unknown'} RigCategory */

/**
 * Classify an avatar's rig state from its `source_meta`.
 *
 * - `rigged`  — has a skeleton (flag true, or a positive joint count).
 * - `static`  — inspected and confirmed to have no skeleton.
 * - `unknown` — never skeleton-inspected (older upload); we don't claim either
 *   way so the UI can offer to rig rather than mislabel it "static".
 *
 * @param {{ source_meta?: Record<string, any> } | null | undefined} avatar
 * @returns {{ category: RigCategory, rigged: boolean, known: boolean, jointCount: number|null }}
 */
export function classifyRig(avatar) {
	const meta = avatar?.source_meta || {};
	const flag = meta.is_rigged;
	const jointCount =
		typeof meta.skeleton_joint_count === 'number' ? meta.skeleton_joint_count : null;

	if (flag === true || (jointCount != null && jointCount > 0)) {
		return { category: 'rigged', rigged: true, known: true, jointCount };
	}
	if (flag === false) {
		return { category: 'static', rigged: false, known: true, jointCount: jointCount ?? 0 };
	}
	return { category: 'unknown', rigged: false, known: false, jointCount };
}

/**
 * A small badge for avatar cards/detail views. Returns '' when the rig state is
 * unknown so we never paint a misleading label on un-inspected uploads.
 *
 * @param {Parameters<typeof classifyRig>[0]} avatar
 * @param {{ joints?: boolean }} [opts] — when true, append the joint count to a rigged badge.
 * @returns {string} HTML string (caller controls placement)
 */
export function rigBadgeHTML(avatar, opts = {}) {
	const { category, jointCount } = classifyRig(avatar);
	if (category === 'unknown') return '';
	if (category === 'rigged') {
		const joints =
			opts.joints && jointCount ? ` <span class="rig-badge-joints">${jointCount}</span>` : '';
		return `<span class="rig-badge rig-badge--rigged" title="Skeleton-ready — plays the animation library">⛹ Rigged${joints}</span>`;
	}
	return `<span class="rig-badge rig-badge--static" title="Static mesh — auto-rig it to animate">▢ Static</span>`;
}

if (typeof window !== 'undefined') {
	// Convenience handle for the static (non-bundled) public/gallery script,
	// mirroring the window.twsOnchainBadge bridge.
	window.twsRig = { classifyRig, rigBadgeHTML };
}
