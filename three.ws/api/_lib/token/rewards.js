// Holder-rewards (reflections) distribution — the deflation-free alternative to
// burning. The `rewards` leg of every spend accrues in THREE_REWARDS_WALLET; this
// module computes the pro-rata split of that pool back to holders by their share
// of the eligible supply.
//
// The computation here is PURE (no RPC, no signing) so it's fully testable and the
// cron (api/cron/rewards-distribute.js) stays a thin shell: read snapshot → compute
// plan → execute transfers. Executing the plan needs a funded distributor key; the
// plan itself (who gets what) is deterministic and verifiable offline.

/**
 * Compute a pro-rata distribution of a rewards pool across holders.
 *
 * @param {object} params
 * @param {bigint|string|number} params.poolAtomics  total rewards to distribute (atomics)
 * @param {{ wallet: string, balance: bigint|string|number }[]} params.holders
 *        eligible holders and their $THREE balance (atomics). Zero/negative balances
 *        are dropped. The distributor wallet(s) should be excluded by the caller so
 *        the pool doesn't pay itself.
 * @param {bigint|string|number} [params.minPayoutAtomics=0]  drop dust payouts below this
 * @returns {{ total: bigint, distributed: bigint, dust: bigint, eligibleSupply: bigint,
 *   payouts: { wallet: string, balance: bigint, atomics: bigint }[] }}
 *
 * Guarantees:
 *   • Σ payouts ≤ pool (never over-distributes).
 *   • The rounding remainder is assigned to the largest holder, so Σ payouts +
 *     dust = pool exactly — no atoms created or lost.
 *   • Deterministic ordering (by balance desc, then wallet) so the same snapshot
 *     always yields the same plan (safe to retry / resume).
 */
export function computeRewardsDistribution({ poolAtomics, holders, minPayoutAtomics = 0 }) {
	const pool = BigInt(poolAtomics);
	const minPayout = BigInt(minPayoutAtomics);

	const eligible = (holders || [])
		.map((h) => ({ wallet: h.wallet, balance: BigInt(h.balance) }))
		.filter((h) => h.balance > 0n && typeof h.wallet === 'string' && h.wallet.length > 0)
		.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : a.wallet < b.wallet ? -1 : 1));

	const eligibleSupply = eligible.reduce((s, h) => s + h.balance, 0n);
	if (pool <= 0n || eligibleSupply === 0n) {
		return { total: pool, distributed: 0n, dust: pool, eligibleSupply, payouts: [] };
	}

	// Floor-allocate each holder's share; track the remainder for the top holder.
	let allocated = 0n;
	let payouts = eligible.map((h) => {
		const atomics = (pool * h.balance) / eligibleSupply;
		allocated += atomics;
		return { wallet: h.wallet, balance: h.balance, atomics };
	});

	// Assign the rounding remainder to the largest holder (index 0 after the sort)
	// so Σ payouts == pool before the dust filter.
	const remainder = pool - allocated;
	if (remainder > 0n && payouts.length > 0) payouts[0].atomics += remainder;

	// Drop dust payouts below the floor; those atoms stay in the pool (carried to
	// the next distribution) and are reported as `dust`.
	if (minPayout > 0n) payouts = payouts.filter((p) => p.atomics >= minPayout);

	const distributed = payouts.reduce((s, p) => s + p.atomics, 0n);
	return {
		total: pool,
		distributed,
		dust: pool - distributed,
		eligibleSupply,
		payouts,
	};
}
