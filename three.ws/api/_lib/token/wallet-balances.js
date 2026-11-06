// Live balances of the two public $THREE fund-routing wallets.
//
// The treasury (funds buybacks) and the holder-rewards pool receive a share of
// every $THREE split (SPLIT_POLICIES in ./config.js). Publishing their addresses
// is only half of "people trust what they can check": this module reads what
// each one actually holds, $THREE and USDC, straight from Solana so /three-token
// can show it next to the address.
//
// Honesty contract: a balance is either a real RPC read or explicitly
// unavailable. An empty token-account list is a real zero (the wallet has never
// held that mint); an RPC failure after the whole failover chain is exhausted is
// `null` with `ok: false`, never a zero and never a cached stale number dressed
// up as current.

import { PublicKey } from '@solana/web3.js';
import { rpcFallbackFromEnv } from '../solana/rpc-fallback.js';
import { cacheGet, cacheSet } from '../cache.js';
import { SOLANA_USDC_MINT } from '../../payments/_config.js';
import { TOKEN_MINT, treasuryWalletOrNull, rewardsWalletOrNull } from './config.js';

const CACHE_KEY = 'three-token:public-wallet-balances:v1';
const CACHE_TTL_S = 60;

// The assets shown per wallet. `mint` is resolved at call time so a devnet or
// test override of THREE_TOKEN_MINT / SOLANA_USDC_MINT is honoured.
const ASSETS = [
	{ key: 'three', symbol: '$THREE', mint: () => TOKEN_MINT },
	{ key: 'usdc', symbol: 'USDC', mint: () => SOLANA_USDC_MINT },
];

/**
 * Sum every token account `owner` holds for `mint`. Querying by mint (not by a
 * derived ATA) covers both the classic SPL program and Token-2022, which $THREE
 * uses, and also counts any non-ATA account the wallet happens to own.
 * @returns {Promise<{ amount: number, atomics: string, decimals: number }>}
 */
async function readMintBalance(rpc, owner, mint) {
	const res = await rpc.withFallback((conn) =>
		conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed'),
	);
	let atomics = 0n;
	let decimals = null;
	for (const { account } of res?.value ?? []) {
		const ta = account?.data?.parsed?.info?.tokenAmount;
		if (!ta?.amount) continue;
		atomics += BigInt(ta.amount);
		if (decimals == null && Number.isInteger(ta.decimals)) decimals = ta.decimals;
	}
	const d = decimals ?? 0;
	return { atomics: atomics.toString(), decimals: d, amount: Number(atomics) / 10 ** d };
}

async function readWallet(rpc, address) {
	const balances = {};
	await Promise.all(
		ASSETS.map(async (asset) => {
			try {
				const b = await readMintBalance(rpc, address, asset.mint());
				balances[asset.key] = { symbol: asset.symbol, ok: true, ...b };
			} catch (err) {
				console.warn(`[three-token] ${asset.symbol} balance read failed for ${address}:`, err?.message || err);
				balances[asset.key] = { symbol: asset.symbol, ok: false, amount: null, atomics: null, decimals: null };
			}
		}),
	);
	return balances;
}

/**
 * Public, read-only snapshot of the treasury and rewards wallets.
 * Unconfigured wallets are listed with `configured: false` so the page can say
 * "not yet published" instead of hiding the row.
 * @returns {Promise<{ as_of: string, wallets: Array<{ role: string, address: string|null, configured: boolean, balances: object|null }> }>}
 */
export async function publicWalletBalances() {
	const cached = await cacheGet(CACHE_KEY);
	if (cached) return cached;

	const targets = [
		{ role: 'treasury', address: treasuryWalletOrNull() },
		{ role: 'rewards', address: rewardsWalletOrNull() },
	];
	const needsRpc = targets.some((t) => t.address);
	const rpc = needsRpc ? rpcFallbackFromEnv({ network: 'mainnet', commitment: 'confirmed' }) : null;

	const wallets = await Promise.all(
		targets.map(async (t) => ({
			role: t.role,
			address: t.address,
			configured: t.address != null,
			balances: t.address ? await readWallet(rpc, t.address) : null,
		})),
	);
	const snapshot = { as_of: new Date().toISOString(), wallets };

	// Cache only a fully successful read: a partial failure must be retried on
	// the next request, not pinned for a minute.
	const allOk = wallets.every((w) => !w.balances || Object.values(w.balances).every((b) => b.ok));
	if (allOk) cacheSet(CACHE_KEY, snapshot, CACHE_TTL_S).catch(() => {});
	return snapshot;
}
