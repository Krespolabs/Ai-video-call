// agent-sniper — first-claim entry scoring. Pure, no I/O.
//
// Given a first-claim event (from scanFirstClaims) and a first_claim strategy
// row, decide whether the agent should snipe the claimed coin. Mirrors
// scorer.js for the new-mint path: returns { pass, reasons }, and `reasons`
// always explains the verdict so the logs show WHY a claim was acted on or
// skipped.

function bigOrNull(v) {
	if (v == null || v === '') return null;
	try {
		return BigInt(String(v).split('.')[0]);
	} catch {
		return null;
	}
}

/**
 * @param {{creator:string, mint:string, signature:string, lamports:number, ts:number}} claim
 * @param {object} strat  agent_sniper_strategies row (trigger = 'first_claim')
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function scoreClaim(claim, strat) {
	const reasons = [];

	// A claim with no resolvable coin mint isn't snipeable — nothing to buy.
	if (!claim.mint) return { pass: false, reasons: ['no_mint'] };

	const lamports = (() => {
		const n = Number(claim.lamports);
		return Number.isFinite(n) && n > 0 ? BigInt(Math.floor(n)) : 0n;
	})();

	const minClaim = bigOrNull(strat.min_claim_lamports);
	const maxClaim = bigOrNull(strat.max_claim_lamports);
	if (minClaim != null && lamports < minClaim) {
		return { pass: false, reasons: ['claim_below_min'] };
	}
	if (maxClaim != null && lamports > maxClaim) {
		return { pass: false, reasons: ['claim_above_max'] };
	}

	reasons.push(`first_claim_sol:${(Number(lamports) / 1e9).toFixed(4)}`);
	return { pass: true, reasons };
}
