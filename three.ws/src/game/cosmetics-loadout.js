// Cosmetic loadout — applies a player's equipped wardrobe to their avatar rig.
//
// A loadout is the set of cosmetics a player wears, at most one per slot (dye /
// headwear / eyewear / aura — see cosmetics-catalog.js). Each cosmetic carries a
// `visual` spec that cosmetics-visual.js turns into Three.js objects; this module
// is the thin layer that maps an equipped loadout to those visuals and aggregates
// them into one handle the rig owner drives.
//
// It's the single client-side entry point for cosmetics, used identically for the
// local player (coincommunities), every remote peer (RemotePlayer), and the
// character-creator preview — so one wardrobe renders the same everywhere.
//
// Usage mirrors the rig lifecycle: applyLoadout() right after the avatar GLB
// loads, tick(dt) each frame, and re-apply (dispose the old handle, build a new
// one) whenever the avatar reloads or the loadout changes — loading a model
// clears the rig, taking the cosmetic layers with it.

import { applyCosmetic } from './cosmetics-visual.js';
import { parseLoadout, serializeLoadout, SLOTS } from '../../multiplayer/src/cosmetics-catalog.js';

// Apply an equipped loadout (either the wire string peers broadcast, or an
// {slot:id} map the creator/owner holds) to `rig` at the avatar's head-anchor
// `height`. Returns { tick(dt), dispose() }: one applyCosmetic handle per worn
// cosmetic, fanned out so a dye, a hat, glasses and an aura all coexist (each
// applyCosmetic call owns one visual primitive). Empty/none loadout → a no-op
// handle, so callers never branch on "is anything equipped".
export function applyLoadout(rig, height, loadout) {
	const wire = typeof loadout === 'string' ? loadout : serializeLoadout(loadout);
	const cosmetics = parseLoadout(wire);
	const handles = cosmetics.map((c) => applyCosmetic(rig, height, c.visual));
	return {
		tick: (dt) => { for (const h of handles) h.tick(dt); },
		dispose: () => { for (const h of handles) { try { h.dispose(); } catch {} } },
		// The normalized wire form actually applied — lets a caller cheaply detect a
		// no-op change ("did the loadout really differ?") before re-applying.
		wire,
	};
}

export { SLOTS };
