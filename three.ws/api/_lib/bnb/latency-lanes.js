/**
 * Multi-chain block-time probe for the /bnb-latency race page.
 *
 * Reuses `probeBlockTime` from ./chains.js for BNB Chain (the single source
 * of truth for BSC RPCs — never duplicated here) and adds the same
 * measured-not-hardcoded technique for Base, Ethereum, and Solana so the
 * page can race real chains side by side. Base/Ethereum RPC lists are
 * reused verbatim from `api/_lib/erc8004-chains.js` (already probed live
 * for keyless server-side reachability — see that file's comments on which
 * public endpoints 403 from datacenter IPs) instead of inventing a new set.
 * Solana uses the platform's existing failover `solanaConnection()`.
 *
 * Every lane resolves (never throws) to `{ ok:false, error }` on total
 * failure so one dead chain never takes the others down with it — the
 * /bnb-latency page keeps racing the lanes that are up.
 */

import { createPublicClient, http } from 'viem';
import { probeBlockTime, BnbRpcError } from './chains.js';
import { CHAINS as EVM_CHAINS } from '../erc8004-chains.js';
import { solanaConnection } from '../solana/connection.js';

const DEFAULT_TIMEOUT_MS = 5000;

function rpcUrlsFor(chainId) {
	const chain = EVM_CHAINS.find((c) => c.id === chainId);
	return chain?.rpcUrls || [];
}

/**
 * Measure BNB Chain (mainnet) via the canonical `probeBlockTime`, normalized
 * to the same lane shape every other probe returns.
 */
export async function probeBnbLane({ sampleBlocks = 60 } = {}) {
	try {
		const r = await probeBlockTime('bscMainnet', sampleBlocks);
		return {
			id: 'bnb',
			name: 'BNB Chain',
			chainId: 56,
			ok: true,
			avgBlockTimeMs: r.avgBlockTimeMs,
			latestBlock: r.latestBlock,
			sampleBlocks: r.sampleBlocks,
			target: r.target,
			measuredAt: r.measuredAt,
		};
	} catch (err) {
		return {
			id: 'bnb',
			name: 'BNB Chain',
			chainId: 56,
			ok: false,
			error: 'rpc_unreachable',
			tried: err instanceof BnbRpcError ? err.tried : undefined,
			target: 450,
		};
	}
}

/**
 * Measure any EVM chain's block time by sampling two blocks `sampleBlocks`
 * apart off a public RPC (with failover across `rpcUrls`), mirroring
 * `probeBlockTime`'s technique exactly. Never throws — a total failure
 * across every URL resolves to `{ ok:false }` so the caller can degrade one
 * lane without failing the whole page.
 */
export async function probeEvmLane({ id, name, chainId, rpcUrls, sampleBlocks = 30, target = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	const tried = [];
	for (const url of rpcUrls) {
		tried.push(url);
		try {
			const client = createPublicClient({
				chain: {
					id: chainId,
					name,
					nativeCurrency: { name, symbol: name.slice(0, 4).toUpperCase(), decimals: 18 },
					rpcUrls: { default: { http: [url] }, public: { http: [url] } },
				},
				transport: http(url, { timeout: timeoutMs, retryCount: 0 }),
			});
			const latest = await client.getBlock({ blockTag: 'latest' });
			const latestNumber = Number(latest.number);
			const olderNumber = BigInt(Math.max(0, latestNumber - Math.max(1, Math.floor(sampleBlocks))));
			const older = await client.getBlock({ blockNumber: olderNumber });
			const blocks = latestNumber - Number(older.number);
			const deltaMs = (Number(latest.timestamp) - Number(older.timestamp)) * 1000;
			const avgBlockTimeMs = blocks > 0 ? Math.round((deltaMs / blocks) * 100) / 100 : 0;
			return {
				id,
				name,
				chainId,
				ok: true,
				avgBlockTimeMs,
				latestBlock: latestNumber,
				sampleBlocks: blocks,
				target,
				measuredAt: new Date().toISOString(),
			};
		} catch {
			// try the next RPC in the list
		}
	}
	return { id, name, chainId, ok: false, error: 'rpc_unreachable', tried, target };
}

/**
 * Measure Solana's live slot cadence via `getRecentPerformanceSamples` — one
 * RPC call returns a real recent window's `samplePeriodSecs / numSlots`,
 * which is the network's own accounting of its slot time (no manual block
 * walking needed, unlike the EVM lanes). Solana isn't an EVM chain and
 * "block" here means "slot" — surfaced as such in the returned shape.
 */
export async function probeSolanaLane({ target = 400 } = {}) {
	try {
		const conn = solanaConnection({ network: 'mainnet' });
		const [samples, slot] = await Promise.all([conn.getRecentPerformanceSamples(1), conn.getSlot('confirmed')]);
		const sample = samples?.[0];
		if (!sample || !sample.numSlots) throw new Error('no recent performance samples');
		const avgBlockTimeMs = Math.round(((sample.samplePeriodSecs * 1000) / sample.numSlots) * 100) / 100;
		return {
			id: 'solana',
			name: 'Solana',
			chainId: null,
			ok: true,
			avgBlockTimeMs,
			latestBlock: slot,
			sampleBlocks: sample.numSlots,
			target,
			measuredAt: new Date().toISOString(),
		};
	} catch {
		return { id: 'solana', name: 'Solana', chainId: null, ok: false, error: 'rpc_unreachable', target };
	}
}

/**
 * Probe all four race lanes in parallel. Each probe already fails closed to
 * `{ ok:false }` internally, so `Promise.all` here never rejects — a dead
 * chain shows as a degraded lane in the response, not a 502 for the whole
 * page.
 */
export async function probeAllLanes() {
	const [bnb, base, ethereum, solana] = await Promise.all([
		probeBnbLane(),
		probeEvmLane({ id: 'base', name: 'Base', chainId: 8453, rpcUrls: rpcUrlsFor(8453), sampleBlocks: 30, target: 2000 }),
		probeEvmLane({ id: 'ethereum', name: 'Ethereum', chainId: 1, rpcUrls: rpcUrlsFor(1), sampleBlocks: 12, target: 12000 }),
		probeSolanaLane({ target: 400 }),
	]);
	return [bnb, base, ethereum, solana];
}
