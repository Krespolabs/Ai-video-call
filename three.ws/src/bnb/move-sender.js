/**
 * Browser-side gasless move sender for BNB Chain (prompt 15).
 *
 * A thin wrapper around api/_lib/bnb/world-moves.js's `MoveCoalescer` +
 * `sendMove` for prompt 16's on-chain presence toggle: feed it the player's
 * local position every frame, it converts engine units (Three.js meters,
 * radians) into WorldMoves' contract units (int32 millimeters, uint16
 * millidegrees) and emits sponsored `move()` txs at a self-throttling
 * ~1-per-block cadence — see "Cadence" below — at zero gas cost to the
 * player.
 *
 * `world-moves.js` is isomorphic (only `viem` + `fetch`, no Node-only APIs),
 * so this module runs unmodified in the browser via Vite's bundle — no
 * server relay hop needed for the happy path: MegaFuel's testnet paymaster
 * (`bsc-megafuel-testnet.nodereal.io`) was confirmed live 2026-07-08 to send
 * `access-control-allow-origin: *` on both its `OPTIONS` preflight and the
 * real `pm_isSponsorable` POST, so a direct cross-origin browser call works
 * today. If that policy ever tightens, a thin server relay (the same shape
 * as `api/bnb/register-agent.js`, which relays already-signed bytes without
 * touching a key) is the documented fallback — not needed yet.
 *
 * Wallet-agnostic on purpose: pass any viem `Account` (ephemeral, browser
 * wallet-backed — whatever prompt 16's connect flow produces). This module
 * never generates, stores, or reads a private key itself.
 */

import { MoveCoalescer, sendMove, COORD_MIN, COORD_MAX } from '../../api/_lib/bnb/world-moves.js';

/**
 * World meters → WorldMoves int32 units. WorldMoves.sol's NatSpec documents
 * its coordinate space as "1 unit = 1mm" (an 8.39km cube) — matching that
 * convention here means a scene authored in meters gets millimeter
 * precision, comfortably enough for any three.ws world.
 */
export const COORD_SCALE = 1000;

/** Convert a player position in engine meters to WorldMoves int32 coordinates. */
export function toContractPos({ x, y, z }) {
	return {
		x: Math.round(x * COORD_SCALE),
		y: Math.round(y * COORD_SCALE),
		z: Math.round(z * COORD_SCALE),
	};
}

/**
 * Convert a heading in radians to the contract's uint16 facing. WorldMoves.sol
 * leaves the unit fully caller-defined ("Not range-checked: any uint16 is a
 * valid facing") and suggests one convention in its NatSpec — its numeric
 * range (0..35999 for a full turn) only actually holds at 0.01°
 * resolution (centidegrees), matched exactly here so any indexer/renderer
 * following that same convention decodes our facing correctly.
 */
export function toContractFacing(radians) {
	const twoPi = Math.PI * 2;
	const normalized = ((radians % twoPi) + twoPi) % twoPi; // wrap into [0, 2π)
	const centidegrees = Math.round(((normalized * 180) / Math.PI) * 100);
	return centidegrees >= 36000 ? 0 : centidegrees; // 360.00° wraps to 0°, never leaves the 0..35999 convention range
}

/** Whether a world-space position (in meters) lands inside WorldMoves' representable cube. */
export function isWithinWorldMovesRange(positionMeters) {
	const p = toContractPos(positionMeters);
	return p.x >= COORD_MIN && p.x <= COORD_MAX && p.y >= COORD_MIN && p.y <= COORD_MAX && p.z >= COORD_MIN && p.z <= COORD_MAX;
}

/**
 * Create a move sender bound to one player/world/network. Nothing runs until
 * `updatePosition` is called — creating a sender never fires a wallet prompt
 * or a network request on its own.
 *
 * @param {object} params
 * @param {import('viem').Account} params.account viem account (ephemeral or wallet-backed); never read here beyond signing
 * @param {number} params.worldId uint32 world/room id
 * @param {'bscMainnet'|'bscTestnet'|56|97} [params.network]
 * @param {(result:{hash:string, mode:'sponsored'|'self-pay'}) => void} [params.onSent]
 * @param {(err:Error) => void} [params.onError] a declined/failed send NEVER throws out of `updatePosition` — it's always reported here so local movement never freezes
 * @param {string} [params.address] WorldMoves contract address override (tests, or before the env-configured deployment exists)
 * @param {object} [params.megafuelOpts] forwarded to sendGasless (publicClient/walletClient/megafuelRpc — tests)
 */
export function createMoveSender({ account, worldId, network = 'bscTestnet', onSent, onError, address, ...megafuelOpts }) {
	let lastKey = null; // dedupe: skip a resubmit if the quantized position/facing hasn't actually changed

	const coalescer = new MoveCoalescer(
		async ({ pos, facing }) => sendMove({ account, worldId, pos, facing, network }, { address, ...megafuelOpts }),
		{
			onSent: (result) => onSent?.(result),
			onError: (err) => onError?.(err),
		},
	);

	return {
		/**
		 * Feed the latest local position/heading — call every frame or physics
		 * tick. Cadence is self-throttling by construction: `MoveCoalescer`
		 * only launches a new send once the previous one's round trip (which
		 * MegaFuel/BSC dominate at ~0.45s block time + RPC latency) has
		 * resolved, so a 60fps caller still produces roughly one on-chain move
		 * per block, not per frame — exactly the "target ~1 per block" the
		 * prompt calls for, with zero extra timer logic.
		 * @param {{x:number,y:number,z:number}} positionMeters
		 * @param {number} [headingRadians]
		 */
		updatePosition(positionMeters, headingRadians = 0) {
			if (!isWithinWorldMovesRange(positionMeters)) return; // out of bounds — never fire a doomed on-chain revert
			const pos = toContractPos(positionMeters);
			const facing = toContractFacing(headingRadians);
			const key = `${pos.x},${pos.y},${pos.z},${facing}`;
			if (key === lastKey) return; // stationary — don't spam identical moves
			lastKey = key;
			coalescer.submit({ pos, facing });
		},

		/** Current sender counters (sent/coalesced/errors/inFlight) — wire to a status readout. */
		get stats() {
			return coalescer.stats;
		},

		/** Stop emitting further on-chain moves (e.g. toggle OFF). Local movement is never affected — this only stops the chain writes. */
		stop() {
			coalescer.dispose();
		},
	};
}
