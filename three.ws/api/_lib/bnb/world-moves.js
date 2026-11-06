/**
 * WorldMoves on-chain move sender for BNB Chain (prompt 15).
 *
 * Combines the two headline BNB capabilities verified in 00-CONTEXT into one
 * felt experience: a plain empty wallet writes its position to chain every
 * ~0.45s (BSC's live Fermi block time) at ZERO gas cost, via MegaFuel's
 * gasless sponsorship (api/_lib/bnb/megafuel.js, prompt 02 — mandatory
 * self-pay fallback baked in there already).
 *
 * Three layers, smallest first:
 *  1. `buildMoveTx`/`buildJoinTx`/`buildLeaveTx`/`buildCheckpointTx` — pure
 *     calldata encoders against the deployed WorldMoves.sol (prompt 14).
 *  2. `sendMove`/`sendJoin`/`sendLeave` — route an encoded call through
 *     `megafuel.sendGasless`, returning `{ hash, mode }`.
 *  3. `MoveCoalescer` — a pure, network-free scheduler so a position stream
 *     updating far faster than BSC confirms blocks (every frame vs. every
 *     ~0.45s) produces at most one in-flight send + one queued latest
 *     position, never a pending-tx pileup.
 *
 * Isomorphic on purpose (only `viem` + this repo's `chains.js`/`megafuel.js`,
 * no Node-only APIs) so `src/bnb/move-sender.js` can import it straight into
 * the browser bundle for prompt 16's on-chain presence toggle.
 */

import { encodeFunctionData, parseAbi } from 'viem';
import { getPublicClient, BNB_CHAINS, assertBscAddress } from './chains.js';
import { sendGasless } from './megafuel.js';

/** Mirrors contracts/src/WorldMoves.sol's external surface exactly. */
export const WORLD_MOVES_ABI = parseAbi([
	'function join(uint32 worldId) external',
	'function leave(uint32 worldId) external',
	'function move(uint32 worldId, int32 x, int32 y, int32 z, uint16 facing) external',
	'function checkpoint(uint32 worldId, int32 x, int32 y, int32 z, uint16 facing) external',
	'event Moved(uint32 indexed worldId, address indexed player, int32 x, int32 y, int32 z, uint16 facing, uint256 blockNumber, uint256 timestamp)',
	'event Joined(uint32 indexed worldId, address indexed player, uint256 timestamp)',
	'event Left(uint32 indexed worldId, address indexed player, uint256 timestamp)',
]);

/** Signed 24-bit coordinate bound — mirrors WorldMoves.sol's COORD_MIN/MAX exactly. */
export const COORD_MIN = -8_388_608;
export const COORD_MAX = 8_388_607;

export class WorldMovesError extends Error {
	/** @param {string} message @param {{ code?: string, cause?: unknown }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'WorldMovesError';
		this.code = info.code || 'world_moves_error';
		if (info.cause) this.cause = info.cause;
	}
}

function normalizeNetwork(network) {
	if (network === 56 || network === '56' || network === 'bsc' || network === 'mainnet' || network === 'bscMainnet') return 'bscMainnet';
	return 'bscTestnet';
}

function assertWorldId(worldId) {
	if (!Number.isInteger(worldId) || worldId < 0 || worldId > 0xffffffff) {
		throw new WorldMovesError(`worldId=${worldId} must be a uint32 (0..4294967295)`, { code: 'bad_world_id' });
	}
}

function assertCoord(name, v) {
	if (!Number.isInteger(v) || v < COORD_MIN || v > COORD_MAX) {
		throw new WorldMovesError(`${name}=${v} is out of WorldMoves bounds [${COORD_MIN}, ${COORD_MAX}]`, { code: 'coord_out_of_bounds' });
	}
}

function assertPos(pos) {
	if (!pos || typeof pos !== 'object') {
		throw new WorldMovesError('pos must be an { x, y, z } object of int32 WorldMoves coordinates', { code: 'bad_pos' });
	}
	assertCoord('x', pos.x);
	assertCoord('y', pos.y);
	assertCoord('z', pos.z);
}

function assertFacing(facing) {
	if (!Number.isInteger(facing) || facing < 0 || facing > 0xffff) {
		throw new WorldMovesError(`facing=${facing} must be a uint16 (0..65535)`, { code: 'bad_facing' });
	}
}

/** Reads a 0x-prefixed 20-byte address out of `process.env[name]`, else null. */
function envAddress(name) {
	const v = typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
	return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

/**
 * Deployed WorldMoves addresses per chain, resolved from env so a real
 * public-testnet deploy — currently blocked on a funded deployer key, see
 * contracts/DEPLOYMENTS.md's WorldMoves section and PROGRESS.md prompt 14 —
 * can be wired in with zero code change (`WORLD_MOVES_ADDRESS_TESTNET`).
 * Deliberately no hardcoded fallback: the only real broadcast so far is the
 * anvil-fork-local address recorded in DEPLOYMENTS.md, which is NOT a public
 * BscScan-resolvable deployment and must never be mistaken for one.
 */
export const WORLD_MOVES_DEPLOYMENTS = {
	56: envAddress('WORLD_MOVES_ADDRESS_MAINNET'),
	97: envAddress('WORLD_MOVES_ADDRESS_TESTNET'),
};

/**
 * Resolve the deployed WorldMoves address for `network`. `opts.address`
 * (tests, the anvil-fork demo, or a caller that already knows the address)
 * always wins over the env-configured deployment.
 * @param {'bscMainnet'|'bscTestnet'|56|97} [network]
 * @param {{ address?: string }} [opts]
 * @returns {`0x${string}`}
 */
export function worldMovesAddress(network, opts = {}) {
	if (opts.address) return assertBscAddress(opts.address);
	const key = normalizeNetwork(network);
	const chainId = BNB_CHAINS[key].id;
	const configured = WORLD_MOVES_DEPLOYMENTS[chainId];
	if (!configured) {
		const envVar = chainId === 56 ? 'WORLD_MOVES_ADDRESS_MAINNET' : 'WORLD_MOVES_ADDRESS_TESTNET';
		throw new WorldMovesError(
			`no WorldMoves contract deployed for chain ${chainId} yet — set ${envVar} once it is (see contracts/DEPLOYMENTS.md), or pass opts.address explicitly`,
			{ code: 'no_deployment' },
		);
	}
	return assertBscAddress(configured);
}

function buildTx(functionName, args, opts) {
	const to = worldMovesAddress(opts.network, opts);
	const data = encodeFunctionData({ abi: WORLD_MOVES_ABI, functionName, args });
	return { to, data, value: 0n };
}

/**
 * Encode a `WorldMoves.move(worldId, x, y, z, facing)` call. Pure — no
 * network access, no signing. `pos` coordinates and `facing` are already in
 * contract units (int32 WorldMoves-space, uint16 heading respectively); a
 * caller working in engine units (meters, radians) converts before calling
 * this, see `src/bnb/move-sender.js` for the browser-facing conversion.
 *
 * @param {number} worldId uint32 world/room id
 * @param {{ x:number, y:number, z:number }} pos int32 WorldMoves coordinates
 * @param {number} facing uint16 heading
 * @param {{ network?: 'bscMainnet'|'bscTestnet'|56|97, address?: string }} [opts]
 * @returns {{ to:`0x${string}`, data:`0x${string}`, value:0n }}
 */
export function buildMoveTx(worldId, pos, facing, opts = {}) {
	assertWorldId(worldId);
	assertPos(pos);
	assertFacing(facing);
	return buildTx('move', [worldId, pos.x, pos.y, pos.z, facing], opts);
}

/** Encode a `WorldMoves.join(worldId)` call — announce presence, event-only. */
export function buildJoinTx(worldId, opts = {}) {
	assertWorldId(worldId);
	return buildTx('join', [worldId], opts);
}

/** Encode a `WorldMoves.leave(worldId)` call — announce departure, event-only. */
export function buildLeaveTx(worldId, opts = {}) {
	assertWorldId(worldId);
	return buildTx('leave', [worldId], opts);
}

/** Encode a `WorldMoves.checkpoint(worldId, x, y, z, facing)` call — the one storage-writing variant. */
export function buildCheckpointTx(worldId, pos, facing, opts = {}) {
	assertWorldId(worldId);
	assertPos(pos);
	assertFacing(facing);
	return buildTx('checkpoint', [worldId, pos.x, pos.y, pos.z, facing], opts);
}

/**
 * Send a built tx gaslessly via MegaFuel (self-pay fallback baked into
 * `sendGasless` itself — never a hard failure on the sponsorship path alone).
 * @param {import('viem').Account} account
 * @param {{ to:string, data:string, value?:bigint }} tx
 * @param {'bscMainnet'|'bscTestnet'|56|97} network
 * @param {object} [opts] forwarded to sendGasless (publicClient/walletClient/megafuelRpc — tests)
 * @returns {Promise<{ hash:`0x${string}`, mode:'sponsored'|'self-pay', sponsor?:object|null, reason?:string|null }>}
 */
async function sendTx(account, tx, network, opts = {}) {
	return sendGasless(network, { account, tx }, opts);
}

/**
 * Build + gaslessly send a `move()` call. The primary entry point for both
 * the browser sender (prompt 16) and any server-side/demo caller.
 * @param {{ account: import('viem').Account, worldId:number, pos:{x:number,y:number,z:number}, facing:number, network?: 'bscMainnet'|'bscTestnet'|56|97 }} params
 * @param {object} [opts] forwarded to sendGasless + worldMovesAddress (`opts.address` override, test mocks)
 */
export async function sendMove({ account, worldId, pos, facing, network = 'bscTestnet' }, opts = {}) {
	const tx = buildMoveTx(worldId, pos, facing, { network, address: opts.address });
	return sendTx(account, tx, network, opts);
}

/** Build + gaslessly send a `join()` call. */
export async function sendJoin({ account, worldId, network = 'bscTestnet' }, opts = {}) {
	const tx = buildJoinTx(worldId, { network, address: opts.address });
	return sendTx(account, tx, network, opts);
}

/** Build + gaslessly send a `leave()` call. */
export async function sendLeave({ account, worldId, network = 'bscTestnet' }, opts = {}) {
	const tx = buildLeaveTx(worldId, { network, address: opts.address });
	return sendTx(account, tx, network, opts);
}

/**
 * A pure, network-free "at most one in-flight + one latest-wins pending"
 * scheduler. Feed it positions as fast as a render loop produces them (every
 * frame, ~60/s); it only ever calls `sendFn` once the previous call has
 * settled, and always with the MOST RECENT input, dropping every
 * superseded one in between. That's what keeps a player moving faster than
 * BSC confirms blocks (~0.45s) from spamming hundreds of pending txs — the
 * exact behaviour the prompt's Tests section requires, verified network-free
 * in tests/bnb-world-moves.test.js.
 *
 * `sendFn` failures never throw out of `submit()` — they're reported via
 * `onError` so a flaky/declined send never wedges the coalescer or freezes
 * the caller's game loop (00-CONTEXT: "never freeze the game").
 */
export class MoveCoalescer {
	/**
	 * @param {(input:any) => Promise<any>} sendFn
	 * @param {{ onSent?:(result:any, input:any)=>void, onError?:(err:Error, input:any)=>void }} [opts]
	 */
	constructor(sendFn, opts = {}) {
		if (typeof sendFn !== 'function') {
			throw new WorldMovesError('MoveCoalescer requires a send(input) function', { code: 'bad_send_fn' });
		}
		this._send = sendFn;
		this._onSent = opts.onSent || (() => {});
		this._onError = opts.onError || (() => {});
		this._inFlight = false;
		this._pending = null;
		this._hasPending = false;
		this._sentCount = 0;
		this._coalescedCount = 0;
		this._errorCount = 0;
		this._disposed = false;
	}

	/**
	 * Submit the latest position/facing (or any opaque input `sendFn`
	 * understands). If a send is already in flight, this replaces whatever was
	 * queued behind it — latest-wins — rather than queuing a second tx.
	 */
	submit(input) {
		if (this._disposed) return;
		if (this._inFlight) {
			if (this._hasPending) this._coalescedCount++;
			this._pending = input;
			this._hasPending = true;
			return;
		}
		this._launch(input);
	}

	async _launch(input) {
		this._inFlight = true;
		try {
			const result = await this._send(input);
			this._sentCount++;
			this._onSent(result, input);
		} catch (err) {
			this._errorCount++;
			this._onError(err, input);
		} finally {
			this._inFlight = false;
			if (!this._disposed && this._hasPending) {
				const next = this._pending;
				this._pending = null;
				this._hasPending = false;
				this._launch(next);
			}
		}
	}

	/** Snapshot counters — useful for tests and a UI status readout alike. */
	get stats() {
		return {
			sent: this._sentCount,
			coalesced: this._coalescedCount,
			errors: this._errorCount,
			inFlight: this._inFlight,
			hasPending: this._hasPending,
		};
	}

	/** Stop launching further sends. Any send already in flight still settles naturally. */
	dispose() {
		this._disposed = true;
		this._pending = null;
		this._hasPending = false;
	}
}

/** Re-exported so callers don't need a separate `chains.js` import for a public client. */
export { getPublicClient };
