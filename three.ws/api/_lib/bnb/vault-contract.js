/**
 * On-chain reads for `GreenfieldVault.sol` (prompt 10) — the marketplace
 * contract `api/vault/*` (prompt 11) is built on. Mirrors
 * `contracts/src/GreenfieldVault.sol`'s external surface exactly (see
 * `contracts/DEPLOYMENTS.md`'s GreenfieldVault section for addresses/status).
 * Read-only: no signing, no private keys — buying/listing/revoking happen
 * from the buyer's/seller's own wallet directly against the contract (the
 * vault UI, prompt 12), not relayed through this server.
 */

import { parseAbi } from 'viem';
import { getPublicClient, BNB_CHAINS, assertBscAddress } from './chains.js';

/** Mirrors contracts/src/GreenfieldVault.sol's external read surface + events exactly. */
export const GREENFIELD_VAULT_ABI = parseAbi([
	'function listings(bytes32) view returns (address seller, uint256 price, bool active)',
	'function sales(uint256) view returns (bytes32 objectId, address buyer, address seller, uint256 price, uint256 policyId, uint8 status)',
	'function saleIdOf(bytes32, address) view returns (uint256)',
	'function pendingWithdrawals(address) view returns (uint256)',
	'function quoteRelayFee() view returns (uint256 relayFee, uint256 minAckRelayFee, uint256 total)',
	'event Listed(bytes32 indexed objectId, address indexed seller, uint256 price)',
	'event Delisted(bytes32 indexed objectId, address indexed seller)',
	'event Purchased(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint256 price)',
	'event PolicyGranted(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint256 policyId)',
	'event PolicyGrantFailed(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint32 status)',
	'event RevokeRequested(bytes32 indexed objectId, uint256 indexed saleId, uint256 policyId)',
]);

/** Mirrors `GreenfieldVault.SaleStatus` enum order exactly. */
export const SALE_STATUS = ['Pending', 'Granted', 'Failed', 'Revoked'];

/** Named lookup of the parsed event fragments — indexed by name, never by array position. */
const VAULT_EVENTS = Object.fromEntries(GREENFIELD_VAULT_ABI.filter((item) => item.type === 'event').map((item) => [item.name, item]));

export class VaultContractError extends Error {
	/** @param {string} message @param {{ code?: string, cause?: unknown }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'VaultContractError';
		this.code = info.code || 'vault_contract_error';
		if (info.cause) this.cause = info.cause;
	}
}

/**
 * Resolve the deployed vault contract address for a network. Mirrors
 * `api/bnb/vault-upload.js`'s `vaultContractAddress` (moved here so both the
 * writer and every reader agree on one lookup). Real deploy is blocked on a
 * funded deployer key (contracts/DEPLOYMENTS.md) — until
 * `GREENFIELD_VAULT_ADDRESS_{TESTNET,MAINNET}` is set, this returns the
 * spec-illustrated placeholder address with `deployed:false` rather than
 * inventing a real one.
 * @param {'testnet'|'mainnet'} network
 * @param {string} [override]
 * @returns {{ address: `0x${string}`, deployed: boolean }}
 */
export function vaultContractAddress(network, override) {
	if (override) return { address: assertBscAddress(override), deployed: true };
	const envVar = network === 'mainnet' ? 'GREENFIELD_VAULT_ADDRESS_MAINNET' : 'GREENFIELD_VAULT_ADDRESS_TESTNET';
	const configured = process.env[envVar];
	if (configured) return { address: assertBscAddress(configured), deployed: true };
	return { address: '0x0000000000000000000000000000000000dEaD', deployed: false };
}

/** viem chain key ('bscMainnet'|'bscTestnet') for a 'testnet'|'mainnet' network string. */
export function chainKeyFor(network) {
	return network === 'mainnet' ? 'bscMainnet' : 'bscTestnet';
}

/** Optional env override for how far back `getVaultLogs` scans by default (blocks). */
function defaultLookbackBlocks(network) {
	const envVar = network === 'mainnet' ? 'GREENFIELD_VAULT_LOOKBACK_BLOCKS_MAINNET' : 'GREENFIELD_VAULT_LOOKBACK_BLOCKS_TESTNET';
	const n = Number(process.env[envVar]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100_000; // ~12.5h of BSC testnet blocks at 0.45s
}

/**
 * `listings(objectId)` — active listing state.
 * @returns {Promise<{ seller: `0x${string}`, price: bigint, active: boolean }>}
 */
export async function readListing(client, address, objectId) {
	const [seller, price, active] = await client.readContract({
		address,
		abi: GREENFIELD_VAULT_ABI,
		functionName: 'listings',
		args: [objectId],
	});
	return { seller, price, active };
}

/** `saleIdOf(objectId, buyer)` — 0n if the pair has no open purchase. */
export async function readSaleIdOf(client, address, objectId, buyer) {
	return client.readContract({ address, abi: GREENFIELD_VAULT_ABI, functionName: 'saleIdOf', args: [objectId, buyer] });
}

/**
 * `sales(saleId)` — full sale record, `status` decoded to its string name.
 * @returns {Promise<{ objectId:`0x${string}`, buyer:`0x${string}`, seller:`0x${string}`, price:bigint, policyId:bigint, status:string, statusCode:number }>}
 */
export async function readSale(client, address, saleId) {
	const [objectId, buyer, seller, price, policyId, status] = await client.readContract({
		address,
		abi: GREENFIELD_VAULT_ABI,
		functionName: 'sales',
		args: [saleId],
	});
	return { objectId, buyer, seller, price, policyId, status: SALE_STATUS[status] || 'Unknown', statusCode: status };
}

/** Live quote of the BNB relay fee `buy()`/`revoke()` require on top of price. */
export async function quoteRelayFee(client, address) {
	const [relayFee, minAckRelayFee, total] = await client.readContract({
		address,
		abi: GREENFIELD_VAULT_ABI,
		functionName: 'quoteRelayFee',
	});
	return { relayFee, minAckRelayFee, total };
}

/**
 * Index the vault's `Listed`/`Delisted`/`Purchased`/`PolicyGranted`/
 * `PolicyGrantFailed` events over a bounded block range in one `eth_getLogs`
 * call (viem's multi-event `events` form). Defaults to a recent lookback
 * window (env-overridable) rather than genesis — public RPCs reject
 * unbounded `eth_getLogs` ranges, and a just-deployed contract has no older
 * history to miss anyway.
 * @param {import('viem').PublicClient} client
 * @param {`0x${string}`} address
 * @param {{ fromBlock?: bigint, toBlock?: bigint, network?: string }} [opts]
 */
export async function getVaultLogs(client, address, opts = {}) {
	// `cacheTime: 0` bypasses viem's default block-number memo (client.cacheTime,
	// several seconds by default) — without it, two calls to this function made
	// back-to-back (e.g. a poll right after a `buy()`/settlement tx) could read a
	// STALE `toBlock` and silently miss the very Purchased/PolicyGranted logs the
	// caller is polling for. Caught live: an anvil E2E proof run where a
	// post-settlement getVaultLogs() call returned only the pre-buy `Listed` log
	// until this fix.
	const toBlock = opts.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
	const fromBlock = opts.fromBlock ?? (toBlock > BigInt(defaultLookbackBlocks(opts.network)) ? toBlock - BigInt(defaultLookbackBlocks(opts.network)) : 0n);
	try {
		const logs = await client.getLogs({
			address,
			events: [
				VAULT_EVENTS.Listed,
				VAULT_EVENTS.Delisted,
				VAULT_EVENTS.Purchased,
				VAULT_EVENTS.PolicyGranted,
				VAULT_EVENTS.PolicyGrantFailed,
			],
			fromBlock,
			toBlock,
		});
		return { logs, fromBlock, toBlock };
	} catch (err) {
		throw new VaultContractError(`eth_getLogs failed for GreenfieldVault ${address}: ${err.message}`, { code: 'logs_failed', cause: err });
	}
}

/**
 * viem public client for a 'testnet'|'mainnet' network string, via chains.js.
 * Local-dev/E2E-proof escape hatch only: `BNB_VAULT_RPC_OVERRIDE_{TESTNET,MAINNET}`
 * (comma-separated URLs) redirects vault reads to a local `anvil --chain-id 97`
 * fork instead of the real public RPC — the same anvil-fork technique prompt 11
 * used at the exported-function level, extended here so the REAL running
 * `/api/vault/*` HTTP endpoints (not a reimplementation) can be driven against a
 * genuinely deployed contract for a real browser/Playwright proof. Scoped to
 * this one function (not `chains.js` globally) so `probeBlockTime`'s "always the
 * real public RPC" honesty guarantee on `/bnb`/`/bnb-latency` is never affected.
 * Unset in production — falls through to the real public testnet/mainnet RPCs.
 */
export function vaultClient(network) {
	const key = chainKeyFor(network);
	const envVar = key === 'bscMainnet' ? 'BNB_VAULT_RPC_OVERRIDE_MAINNET' : 'BNB_VAULT_RPC_OVERRIDE_TESTNET';
	const override = process.env[envVar];
	if (override) {
		const rpcs = override.split(',').map((s) => s.trim()).filter(Boolean);
		if (rpcs.length) return getPublicClient(key, { rpcs, cache: false });
	}
	return getPublicClient(key);
}

/** BscScan explorer base for a network string. */
export function explorerFor(network) {
	return BNB_CHAINS[chainKeyFor(network)].explorer;
}
