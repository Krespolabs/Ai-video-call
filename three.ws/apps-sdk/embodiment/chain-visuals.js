/**
 * Chain-state → body visuals — the pure mapping between a persona's on-chain
 * identity (api/_lib/persona-wallet.js#getPersonaIdentity) and what the
 * EmbodimentStage/overlay render. No DOM, no Three.js, no network: a
 * deterministic function of the identity object so it is unit-testable on its
 * own and reusable by both the WebGL stage (aura/muted state) and the DOM
 * overlay (badges/nameplate).
 *
 * Design (per prompt 17 — "the avatar IS the wallet"):
 *   - reputation tier  → an aura color + intensity ringing the body
 *   - holdings tier    → a cosmetic badge chip (bronze/silver/gold/platinum)
 *   - low/zero balance → a muted state (desaturated lighting, dimmed aura)
 *   - verified name    → a nameplate badge
 * Every mapping has a defined value for every tier, INCLUDING the degraded /
 * unranked / none case, so a failed or empty read still renders a designed
 * state — never a blank or crashed body.
 */

// Reputation tier → aura. Colors read: grey (unranked) → amber (emerging) →
// teal (trusted) → violet (eminent) → red (disputed, a real trust signal).
const AURA_BY_REPUTATION_TIER = Object.freeze({
	unranked: { color: '#5b6472', intensity: 0.12, label: 'Unranked' },
	emerging: { color: '#fbbf24', intensity: 0.35, label: 'Emerging' },
	trusted: { color: '#5eead4', intensity: 0.65, label: 'Trusted' },
	eminent: { color: '#a78bfa', intensity: 1.0, label: 'Eminent' },
	disputed: { color: '#fb7185', intensity: 0.5, label: 'Disputed' },
});

// Holdings tier → cosmetic badge chip.
const COSMETIC_BY_HOLDINGS_TIER = Object.freeze({
	none: { glyph: '·', color: '#5b6472', label: 'No holdings' },
	bronze: { glyph: '●', color: '#c2793b', label: 'Bronze holdings' },
	silver: { glyph: '●', color: '#c3c9d6', label: 'Silver holdings' },
	gold: { glyph: '★', color: '#f4c542', label: 'Gold holdings' },
	platinum: { glyph: '✦', color: '#9fe8ff', label: 'Platinum holdings' },
});

/**
 * Map a persona identity (or the visual sub-object already computed by
 * getPersonaIdentity) onto the concrete visuals the viewer renders.
 * @param {object} identity — getPersonaIdentity() result, or its `.visual` field
 * @returns {{aura:object, cosmetic:object, muted:boolean, nameplate:(string|null)}}
 */
export function mapChainStateToVisuals(identity) {
	const v = identity?.visual || identity || {};
	const reputationTier = AURA_BY_REPUTATION_TIER[v.reputation_tier] ? v.reputation_tier : 'unranked';
	const holdingsTier = COSMETIC_BY_HOLDINGS_TIER[v.holdings_tier] ? v.holdings_tier : 'none';
	const muted = !!v.muted;

	const aura = { ...AURA_BY_REPUTATION_TIER[reputationTier], tier: reputationTier };
	// Muted overrides intensity toward near-zero regardless of reputation — a
	// broke wallet reads as dim even if it is well-reputed.
	if (muted) aura.intensity = Math.min(aura.intensity, 0.08);

	return {
		aura,
		cosmetic: { ...COSMETIC_BY_HOLDINGS_TIER[holdingsTier], tier: holdingsTier },
		muted,
		nameplate: v.verified_name || null,
	};
}

export { AURA_BY_REPUTATION_TIER, COSMETIC_BY_HOLDINGS_TIER };
