/**
 * Read-side of on-chain presence (prompt 16): subscribes to WorldMoves'
 * `Moved`/`Joined`/`Left` events for a `worldId` and hands them to the
 * caller. Reads are secret-free (00-CONTEXT: "no secret required for
 * reads"), so this talks straight to a public BSC RPC via viem — no server
 * hop, same posture `src/bnb/move-sender.js` already established for writes.
 *
 * `watchContractEvent` over an `http()` transport polls under the hood (viem
 * has no long-lived subscription without a websocket transport), which is
 * exactly right here: BSC's ~0.45s blocks mean a short poll interval already
 * delivers sub-second-feeling updates without needing a websocket RPC.
 */

import { getPublicClient } from '../../api/_lib/bnb/chains.js';
import { WORLD_MOVES_ABI } from '../../api/_lib/bnb/world-moves.js';

/** How often to poll for new events — comfortably under BSC's ~0.45s block time's "feel" without hammering the public RPC. */
const DEFAULT_POLL_MS = 900;

/** Bounded lookback (in blocks) for the on-join backfill, so a client that just connected sees "who moved recently" without replaying the whole chain. At ~0.45s/block this is roughly the last ~9 minutes. */
const DEFAULT_BACKFILL_BLOCKS = 1200n;

/**
 * @param {object} params
 * @param {number} params.worldId
 * @param {`0x${string}`} params.address WorldMoves contract address
 * @param {'bscMainnet'|'bscTestnet'|56|97} [params.network]
 * @param {(ev:{player:string,x:number,y:number,z:number,facing:number,blockNumber:bigint,timestamp:bigint}) => void} [params.onMove]
 * @param {(ev:{player:string,timestamp:bigint}) => void} [params.onJoin]
 * @param {(ev:{player:string,timestamp:bigint}) => void} [params.onLeave]
 * @param {(err:Error) => void} [params.onError] transport errors never throw out of the watcher — reported here so the caller can degrade gracefully instead of freezing
 * @param {import('viem').PublicClient} [params.publicClient] injectable (tests, or to point at a different RPC/fork)
 * @param {number} [params.pollMs]
 * @param {bigint} [params.backfillBlocks]
 * @returns {Promise<{ stop():void }>}
 */
export async function watchWorldPresence({
	worldId,
	address,
	network = 'bscTestnet',
	onMove,
	onJoin,
	onLeave,
	onError,
	publicClient,
	pollMs = DEFAULT_POLL_MS,
	backfillBlocks = DEFAULT_BACKFILL_BLOCKS,
}) {
	const client = publicClient || getPublicClient(network);
	const stops = [];

	// Bounded backfill so a freshly-opened tab sees recent movers immediately
	// instead of an empty world until the next live event fires.
	try {
		const latest = await client.getBlockNumber();
		const fromBlock = latest > backfillBlocks ? latest - backfillBlocks : 0n;
		const logs = await client.getContractEvents({
			address,
			abi: WORLD_MOVES_ABI,
			eventName: 'Moved',
			args: { worldId },
			fromBlock,
			toBlock: latest,
		});
		// Only the latest position per player matters for a backfill snapshot.
		const latestByPlayer = new Map();
		for (const log of logs) latestByPlayer.set(log.args.player.toLowerCase(), log);
		for (const log of latestByPlayer.values()) onMove?.(eventFromLog(log));
	} catch (err) {
		onError?.(err);
	}

	stops.push(
		client.watchContractEvent({
			address,
			abi: WORLD_MOVES_ABI,
			eventName: 'Moved',
			args: { worldId },
			pollingInterval: pollMs,
			onLogs: (logs) => {
				for (const log of logs) onMove?.(eventFromLog(log));
			},
			onError: (err) => onError?.(err),
		}),
	);

	if (onJoin) {
		stops.push(
			client.watchContractEvent({
				address,
				abi: WORLD_MOVES_ABI,
				eventName: 'Joined',
				args: { worldId },
				pollingInterval: pollMs,
				onLogs: (logs) => {
					for (const log of logs) onJoin({ player: log.args.player, timestamp: log.args.timestamp });
				},
				onError: (err) => onError?.(err),
			}),
		);
	}

	if (onLeave) {
		stops.push(
			client.watchContractEvent({
				address,
				abi: WORLD_MOVES_ABI,
				eventName: 'Left',
				args: { worldId },
				pollingInterval: pollMs,
				onLogs: (logs) => {
					for (const log of logs) onLeave({ player: log.args.player, timestamp: log.args.timestamp });
				},
				onError: (err) => onError?.(err),
			}),
		);
	}

	return {
		stop() {
			for (const stop of stops) {
				try {
					stop();
				} catch {
					/* already torn down */
				}
			}
		},
	};
}

function eventFromLog(log) {
	const { player, x, y, z, facing, blockNumber, timestamp } = log.args;
	return { player, x: Number(x), y: Number(y), z: Number(z), facing: Number(facing), blockNumber, timestamp };
}
