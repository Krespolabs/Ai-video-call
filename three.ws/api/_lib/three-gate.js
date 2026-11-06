// Shared $THREE holder gate utility.
//
// Checks whether a Solana wallet holds at least `min` raw $THREE tokens.
// $THREE is a Token-2022 mint; we query with the standard RPC filter which
// works across both token programs when querying by specific mint.
//
// Used by:
//   - api/pump/check-three-balance.js (public HTTP endpoint)
//   - api/agents/x402/[action].js     (inline gate check in skill executor)

import { PublicKey } from '@solana/web3.js';
import { solanaConnection } from './agent-pumpfun.js';
import { getRedis } from './redis.js';

export const THREE_CA = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const CACHE_TTL_S = 30;

/**
 * Returns { wallet, balance, min, eligible }.
 * Never throws — returns eligible:true on infra failure so the gate fails open.
 */
export async function checkThreeBalance(wallet, min = 1) {
	const minNum = Math.max(0, parseInt(min, 10) || 0);

	const cacheKey = `three-gate:${wallet}:${minNum}`;
	const redis = getRedis();
	if (redis) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) return cached;
		} catch { /* continue */ }
	}

	let balance = 0;
	try {
		const conn = solanaConnection('mainnet');
		const pubkey = new PublicKey(wallet);
		const threeMint = new PublicKey(THREE_CA);
		const accts = await conn.getParsedTokenAccountsByOwner(
			pubkey,
			{ mint: threeMint },
			'confirmed',
		);
		for (const { account } of accts.value) {
			const amt = account?.data?.parsed?.info?.tokenAmount?.amount;
			if (amt) balance += Number(BigInt(amt));
		}
	} catch {
		// RPC failure → fail open (return eligible:true)
		return { wallet, balance: 0, min: minNum, eligible: true };
	}

	const result = { wallet, balance, min: minNum, eligible: balance >= minNum };

	if (redis) {
		redis.set(cacheKey, result, { ex: CACHE_TTL_S }).catch(() => {});
	}

	return result;
}
