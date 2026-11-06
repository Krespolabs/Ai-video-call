/**
 * BABT (Binance Account Bound Token) holder check — a free, KYC-backed
 * sybil-resistance signal unique to BSC.
 *
 * Verified real and third-party-queryable 2026-07-08 (see
 * `docs/bnb-babt-findings.md` for the full research writeup + live probes):
 * BABT is a soulbound BEP-721 extension minted by Binance to identity-verified
 * accounts, deployed and actively minting on BOTH BSC mainnet and testnet.
 * Checking "does address X hold a BABT" costs one free `eth_call` to
 * `balanceOf` on a verified, public contract — no API key, no Binance
 * relationship, no off-chain oracle.
 *
 * Contract addresses are copied verbatim from Binance's own developer docs
 * (developers.binance.com/docs/babt/apis-spec) and independently confirmed via
 * `eth_getCode` (both have deployed bytecode) and `name()` (both return
 * "Binance Account Bound Token"). Never invent or "guess-fix" these addresses.
 *
 * Limitation to respect everywhere this is surfaced (docs/UI copy included):
 * BABT proves the address is *currently* bound to some Binance-KYC'd account —
 * it is not a permanent identity anchor (Binance allows revoke + re-mint to a
 * new wallet, which changes `tokenIdOf`), and the real KYC'd holder base
 * (1.16M+) lives on mainnet — testnet mints are real but developer-only.
 */

import { getPublicClient, assertBscAddress, isEvmAddress, BnbRpcError } from './chains.js';

/** Verified BABT contract addresses (do not invent — see module docstring). */
export const BABT_CONTRACTS = {
	bscMainnet: '0x2B09d47D550061f995A3b5C6F0Fd58005215D7c8',
	bscTestnet: '0x984E6a7b9cb73cB7884c9ca9b1Ee625546F9D0E3',
};

const balanceOfAbi = [
	{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const tokenIdOfAbi = [
	{ type: 'function', name: 'tokenIdOf', stateMutability: 'view', inputs: [{ name: 'from', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

/** Typed error for a BABT contract read failure (RPC/contract unreachable). */
export class BabtCheckError extends Error {
	/** @param {string} message @param {{ network?: string, contract?: string, cause?: unknown }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'BabtCheckError';
		this.network = info.network;
		this.contract = info.contract;
		if (info.cause) this.cause = info.cause;
	}
}

/** @returns {'bscMainnet'|'bscTestnet'} normalized network key; defaults to mainnet (real KYC'd holder base). */
function normalizeNetwork(network) {
	if (network === 97 || network === '97' || network === 'testnet' || network === 'bscTestnet') return 'bscTestnet';
	return 'bscMainnet';
}

/**
 * Check whether `address` holds a BABT (Binance Account Bound Token) — a
 * free, real, on-chain KYC-backed uniqueness signal on BSC.
 *
 * @param {string} address EVM address to check.
 * @param {'bscMainnet'|'bscTestnet'|56|97} [network] Defaults to mainnet, where
 *   the real 1.16M+ KYC'd holder base lives. Pass `'bscTestnet'` to exercise
 *   the integration without a mainnet read (testnet mints are real but are
 *   developer test accounts, not KYC'd users).
 * @param {{ client?: import('viem').PublicClient, contract?: string }} [opts]
 *   `client`/`contract` are injectable for tests; production code should omit
 *   both and let this resolve the real public client + verified contract.
 * @returns {Promise<{ address:string, network:string, holdsBabt:boolean, tokenId:string|null, contract:string, checkedAt:string }>}
 * @throws {TypeError} if `address` is not a syntactically valid EVM address.
 * @throws {BabtCheckError} if the on-chain read fails (RPC/contract unreachable).
 */
export async function hasBabt(address, network = 'bscMainnet', opts = {}) {
	const addr = assertBscAddress(address);
	const key = normalizeNetwork(network);
	const contract = opts.contract || BABT_CONTRACTS[key];
	const client = opts.client || getPublicClient(key);

	let balance;
	try {
		balance = await client.readContract({
			address: contract,
			abi: balanceOfAbi,
			functionName: 'balanceOf',
			args: [addr],
		});
	} catch (err) {
		throw new BabtCheckError(`BABT balanceOf read failed: ${err.shortMessage || err.message}`, {
			network: key,
			contract,
			cause: err,
		});
	}

	const holdsBabt = BigInt(balance) > 0n;
	let tokenId = null;
	if (holdsBabt) {
		try {
			const tid = await client.readContract({
				address: contract,
				abi: tokenIdOfAbi,
				functionName: 'tokenIdOf',
				args: [addr],
			});
			tokenId = tid.toString();
		} catch {
			// tokenIdOf is a secondary detail (Binance's own docs warn against
			// treating it as a stable identity anchor) — a failure here must not
			// downgrade a confirmed balanceOf>0 holder into a false negative.
			tokenId = null;
		}
	}

	return {
		address: addr,
		network: key,
		holdsBabt,
		tokenId,
		contract,
		checkedAt: new Date().toISOString(),
	};
}

export { isEvmAddress, BnbRpcError };
