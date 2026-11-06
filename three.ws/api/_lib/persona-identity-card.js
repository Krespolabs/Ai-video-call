/**
 * The persona identity card — a structured, verifiable projection of a
 * persona's on-chain identity, in the SAME spirit as prompt 08's provenance
 * card (mcp-server/src/lib/agent-commerce.js#buildProvenance): a pure,
 * deterministic builder over already-fetched data, embedded directly in a
 * tool's structuredContent so both the host model and any UI can render it
 * without a second round-trip. Nothing here performs I/O — callers fetch the
 * identity first (getPersonaIdentity) and pass the result in.
 */

function formatUsd(n) {
	if (n == null || !Number.isFinite(Number(n))) return null;
	return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/**
 * @param {object} args
 * @param {object} args.persona   — personaPublicView() projection (name, persona_id, …)
 * @param {object} args.identity  — getPersonaIdentity() result
 * @returns {object} the identity card block
 */
export function buildIdentityCard({ persona, identity }) {
	const v = identity.visual || {};
	return {
		kind: 'persona_identity_card',
		version: 1,
		personaId: persona.persona_id,
		name: persona.name,
		wallet: {
			address: identity.address,
			network: identity.network,
			explorer: identity.explorer,
		},
		balance: {
			sol: identity.balances.sol,
			usdc: identity.balances.usdc,
			totalUsdDisplay: formatUsd(identity.balances.total_usd),
		},
		reputation: {
			tier: v.reputation_tier,
			verifiedFeedback: identity.reputation.feedback.verified,
			totalFeedback: identity.reputation.feedback.total,
			scoreAvgVerified: identity.reputation.feedback.score_avg_verified,
			source: 'threews-solana-attestations',
		},
		holdings: {
			tier: v.holdings_tier,
			assetCount: identity.holdings.count,
			totalUsdDisplay: formatUsd(identity.holdings.total_usd),
		},
		verifiedName: v.verified_name,
		muted: !!v.muted,
		fetchedAt: identity.fetched_at,
	};
}

/** A one-line human-readable summary of the card, for the tool's text content. */
export function summarizeIdentityCard(card) {
	const parts = [
		`${card.name} — ${card.wallet.address.slice(0, 4)}…${card.wallet.address.slice(-4)} (${card.wallet.network})`,
		`${card.reputation.tier} reputation`,
		`${card.holdings.tier} holdings tier`,
	];
	if (card.verifiedName) parts.push(`verified as ${card.verifiedName}`);
	if (card.muted) parts.push('balance muted');
	return parts.join(' · ');
}
