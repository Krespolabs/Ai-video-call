// @ts-check
// Pure accounting for the Fee Bridge. No I/O, so every rule that decides who gets
// how much is unit-tested in tests/fee-bridge-math.test.js.
//
// All amounts are BigInt base units: lamports for SOL, atomics (6dp) for USDC.

export const BPS = 10_000n;

// X handles: 1-15 chars of letters, digits, underscore.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Parse "@handle", "handle", or an x.com / twitter.com profile URL into the bare
 * handle, or null when it is not a valid X handle.
 * @param {unknown} input
 * @returns {string|null}
 */
export function parseXHandle(input) {
	let s = String(input ?? '').trim();
	if (!s) return null;
	s = s.replace(/^https?:\/\//i, '').replace(/^(?:www\.|mobile\.)?(?:x|twitter)\.com\//i, '');
	s = s.replace(/^@/, '').split(/[/?#]/)[0];
	return HANDLE_RE.test(s) ? s : null;
}

/**
 * Split a USDC amount into the recipient share and the $THREE buyback share.
 * The recipient share is floored, so rounding dust always lands in the buyback
 * and the recipient is never credited more than the batch actually produced.
 * @param {bigint} usdcAtomics
 * @param {number|bigint} recipientBps
 * @returns {{ recipient: bigint, buyback: bigint }}
 */
export function splitRecipientBuyback(usdcAtomics, recipientBps) {
	const total = usdcAtomics > 0n ? usdcAtomics : 0n;
	const bps = clampBps(BigInt(recipientBps));
	const recipient = (total * bps) / BPS;
	return { recipient, buyback: total - recipient };
}

/**
 * Net SOL a coin contributes after the bridge's gas for landing it is charged back.
 * @param {bigint} grossLamports
 * @param {bigint} gasLamports
 */
export function netOfGas(grossLamports, gasLamports) {
	const net = grossLamports - (gasLamports > 0n ? gasLamports : 0n);
	return net > 0n ? net : 0n;
}

/**
 * Allocate `total` across weighted keys with the largest-remainder method, so the
 * parts sum to exactly `total` and no key is ever over-allocated by rounding.
 * @param {bigint} total
 * @param {Array<{ key: string, weight: bigint }>} parts
 * @returns {Map<string, bigint>}
 */
export function allocateProRata(total, parts) {
	const out = new Map();
	const live = parts.filter((p) => p.weight > 0n);
	for (const p of parts) out.set(p.key, 0n);
	const sum = live.reduce((a, p) => a + p.weight, 0n);
	if (total <= 0n || sum <= 0n) return out;

	let assigned = 0n;
	const remainders = [];
	for (const p of live) {
		const exact = total * p.weight;
		const share = exact / sum;
		out.set(p.key, (out.get(p.key) ?? 0n) + share);
		assigned += share;
		remainders.push({ key: p.key, rem: exact % sum });
	}
	remainders.sort((a, b) => (a.rem === b.rem ? a.key.localeCompare(b.key) : a.rem > b.rem ? -1 : 1));
	let left = total - assigned;
	for (let i = 0; left > 0n && i < remainders.length; i++, left--) {
		const k = remainders[i].key;
		out.set(k, (out.get(k) ?? 0n) + 1n);
	}
	return out;
}

/**
 * Per-coin USDC credit for a batch. SOL inflows share the USDC the SOL swap produced
 * pro rata to their net lamports; USDC inflows count at face value. Each coin's
 * total is then split recipient/buyback.
 *
 * @param {object} args
 * @param {Array<{ mint: string, handle_lc: string, sol_net: bigint, usdc_in: bigint }>} args.coins
 * @param {bigint} args.usdcFromSol     USDC atomics the SOL swap actually delivered
 * @param {number|bigint} args.recipientBps
 * @returns {{ credits: Array<{ mint: string, handle_lc: string, usdc_atomics: bigint }>, recipientTotal: bigint, buybackTotal: bigint, usdcTotal: bigint }}
 */
export function computeBatchCredits({ coins, usdcFromSol, recipientBps }) {
	const fromSol = allocateProRata(
		usdcFromSol > 0n ? usdcFromSol : 0n,
		coins.map((c) => ({ key: c.mint, weight: c.sol_net })),
	);
	const credits = [];
	let recipientTotal = 0n;
	let buybackTotal = 0n;
	for (const c of coins) {
		const usdc = (fromSol.get(c.mint) ?? 0n) + (c.usdc_in > 0n ? c.usdc_in : 0n);
		const { recipient, buyback } = splitRecipientBuyback(usdc, recipientBps);
		recipientTotal += recipient;
		buybackTotal += buyback;
		if (recipient > 0n) credits.push({ mint: c.mint, handle_lc: c.handle_lc, usdc_atomics: recipient });
	}
	return { credits, recipientTotal, buybackTotal, usdcTotal: recipientTotal + buybackTotal };
}

/**
 * Whether a handle's balance should be paid now.
 * @param {object} args
 * @param {bigint} args.balance       unpaid USDC atomics
 * @param {'auto'|'withdraw'} args.trigger
 * @param {bigint} args.autoFloor     auto payouts wait for this much
 * @param {bigint} args.withdrawFloor manual withdrawals need at least this much
 */
export function payoutDecision({ balance, trigger, autoFloor, withdrawFloor }) {
	if (balance <= 0n) return { pay: false, reason: 'no_balance' };
	const floor = trigger === 'auto' ? autoFloor : withdrawFloor;
	if (balance < floor) return { pay: false, reason: 'below_floor', floor };
	return { pay: true, amount: balance };
}

/**
 * Balance change of one SPL mint for one owner across a landed transaction, from
 * its pre/post token balances. Missing entries count as zero (an account created
 * by the transaction has no pre balance).
 * @param {{ preTokenBalances?: any[]|null, postTokenBalances?: any[]|null }|null|undefined} meta
 * @param {string} owner
 * @param {string} mint
 * @returns {bigint}
 */
export function tokenDelta(meta, owner, mint) {
	const sum = (rows) =>
		(rows || [])
			.filter((r) => r?.owner === owner && r?.mint === mint)
			.reduce((a, r) => a + BigInt(r.uiTokenAmount?.amount ?? '0'), 0n);
	return sum(meta?.postTokenBalances) - sum(meta?.preTokenBalances);
}

/**
 * Lamports an account received across a landed transaction, with the fee added
 * back when that account paid it (so a crank's inflow is not understated by gas).
 * @param {{ preBalances?: number[], postBalances?: number[], fee?: number }|null|undefined} meta
 * @param {number} accountIndex
 * @param {boolean} isFeePayer
 * @returns {bigint}
 */
export function lamportDelta(meta, accountIndex, isFeePayer) {
	if (!meta || accountIndex < 0) return 0n;
	const pre = BigInt(meta.preBalances?.[accountIndex] ?? 0);
	const post = BigInt(meta.postBalances?.[accountIndex] ?? 0);
	return post - pre + (isFeePayer ? BigInt(meta.fee ?? 0) : 0n);
}

function clampBps(bps) {
	if (bps < 0n) return 0n;
	if (bps > BPS) return BPS;
	return bps;
}

/** USDC atomics to a 2dp dollar number, for display only. */
export function usdcToUsd(atomics) {
	return Number(BigInt(atomics ?? 0)) / 1e6;
}
