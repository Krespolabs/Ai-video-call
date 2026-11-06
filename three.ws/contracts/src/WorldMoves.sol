// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title WorldMoves
 * @notice Event-only on-chain move-commit stream for three.ws's real-time
 *         worlds. Designed to be called every ~0.45s per player — BSC's live
 *         block time (Fermi hardfork, BEP-619/590, 2026-01-14) — so the design
 *         goal is minimal gas per call, not queryable on-chain state.
 *
 *         `move()` writes zero storage slots: it only emits `Moved`. Indexers
 *         reconstruct live positions by subscribing to the event stream (the
 *         same pattern a UDP-style game snapshot would use, but with EVM
 *         finality). Storage is opt-in via `checkpoint()`, used only when a
 *         caller actually needs a queryable "last known position" (e.g. a
 *         freshly-joining client backfilling world state before the event
 *         stream catches it up).
 *
 *         No admin key, no owner, no upgradeability, no pausability — the
 *         entire contract is three externally-callable state transitions
 *         (`join`, `move`, `leave`) plus one storage-writing variant
 *         (`checkpoint`). Nothing here can be rugged or bricked.
 *
 * @dev Coordinate bounds: world-space is a signed 24-bit range,
 *      [-8_388_608, 8_388_607], stored in `int32` params for calldata/ABI
 *      simplicity but validated against the tighter 24-bit bound. That's an
 *      8.39km cube at 1 unit = 1mm, or an 8390km cube at 1 unit = 1m — enough
 *      headroom for any three.ws scene while cheaply rejecting garbage/attack
 *      input (e.g. int32 overflow griefing an indexer). Out-of-range
 *      coordinates REVERT (chosen over clamping: clamping would silently
 *      teleport a player to the wall and desync client-predicted state from
 *      the on-chain log; reverting makes bad input the caller's problem, and
 *      failed moves cost the spammer gas without corrupting the stream for
 *      everyone else).
 */
contract WorldMoves {
    /// @notice Inclusive bound for x/y/z on every move/checkpoint. +/- 2^23.
    int32 public constant COORD_MIN = -8_388_608;
    int32 public constant COORD_MAX = 8_388_607;

    /// @dev worldId => player => last checkpointed state. Only populated for
    ///      callers that opt into `checkpoint()`; `move()` never touches this.
    mapping(uint32 => mapping(address => Position)) private _checkpoints;

    struct Position {
        int32 x;
        int32 y;
        int32 z;
        uint16 facing;
        uint64 blockNumber;
        uint64 timestamp;
        bool exists;
    }

    /// @notice Emitted on every move. The primary real-time data feed —
    ///         indexers/clients subscribe to this instead of polling storage.
    event Moved(
        uint32 indexed worldId,
        address indexed player,
        int32 x,
        int32 y,
        int32 z,
        uint16 facing,
        uint256 blockNumber,
        uint256 timestamp
    );

    /// @notice Emitted when a player announces presence in a world.
    event Joined(uint32 indexed worldId, address indexed player, uint256 timestamp);

    /// @notice Emitted when a player announces departure from a world.
    event Left(uint32 indexed worldId, address indexed player, uint256 timestamp);

    /// @notice Emitted by `checkpoint()` — the only call that writes storage.
    event CheckpointSet(
        uint32 indexed worldId,
        address indexed player,
        int32 x,
        int32 y,
        int32 z,
        uint16 facing,
        uint256 blockNumber,
        uint256 timestamp
    );

    error CoordinateOutOfBounds();

    /// @notice Announce presence in `worldId`. Purely an event — no storage,
    ///         no membership check, no capacity limit. Callable freely and
    ///         repeatedly; consumers treat the latest `Joined`/`Left` per
    ///         (worldId, player) as the presence state.
    function join(uint32 worldId) external {
        emit Joined(worldId, msg.sender, block.timestamp);
    }

    /// @notice Announce departure from `worldId`. See `join` for semantics.
    function leave(uint32 worldId) external {
        emit Left(worldId, msg.sender, block.timestamp);
    }

    /// @notice Commit a move. Event-only — no SSTORE — so gas stays flat no
    ///         matter how many times a player calls this (the whole point:
    ///         callers are expected to spam this every ~0.45s).
    /// @param worldId Logical world/room identifier.
    /// @param x,y,z   Position, bounded to [COORD_MIN, COORD_MAX].
    /// @param facing  Heading/orientation, caller-defined units (e.g.
    ///                millidegrees 0..35999, or a packed quaternion index).
    ///                Not range-checked: any uint16 is a valid facing.
    function move(uint32 worldId, int32 x, int32 y, int32 z, uint16 facing) external {
        _checkBounds(x, y, z);
        emit Moved(worldId, msg.sender, x, y, z, facing, block.number, block.timestamp);
    }

    /// @notice Persist the caller's latest position/facing in `worldId` as
    ///         queryable storage. Opt-in and separate from `move()` on
    ///         purpose: most callers never need this (they read the `Moved`
    ///         event log), so paying an SSTORE on every tick would be wasted
    ///         gas for the common case. Use this for the rare read path — a
    ///         client that just connected and needs a synchronous "where is
    ///         everyone right now" without replaying the whole event log.
    function checkpoint(uint32 worldId, int32 x, int32 y, int32 z, uint16 facing) external {
        _checkBounds(x, y, z);
        _checkpoints[worldId][msg.sender] =
            Position({x: x, y: y, z: z, facing: facing, blockNumber: uint64(block.number), timestamp: uint64(block.timestamp), exists: true});
        emit CheckpointSet(worldId, msg.sender, x, y, z, facing, block.number, block.timestamp);
    }

    /// @notice Read a player's last checkpointed position in `worldId`.
    ///         Returns `exists = false` (and zeroed fields) if the player has
    ///         never called `checkpoint()` in that world — `move()` alone
    ///         never populates this.
    function getCheckpoint(uint32 worldId, address player)
        external
        view
        returns (int32 x, int32 y, int32 z, uint16 facing, uint64 blockNumber, uint64 timestamp, bool exists)
    {
        Position storage p = _checkpoints[worldId][player];
        return (p.x, p.y, p.z, p.facing, p.blockNumber, p.timestamp, p.exists);
    }

    function _checkBounds(int32 x, int32 y, int32 z) private pure {
        if (x < COORD_MIN || x > COORD_MAX) revert CoordinateOutOfBounds();
        if (y < COORD_MIN || y > COORD_MAX) revert CoordinateOutOfBounds();
        if (z < COORD_MIN || z > COORD_MAX) revert CoordinateOutOfBounds();
    }
}
