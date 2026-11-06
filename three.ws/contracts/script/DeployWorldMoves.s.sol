// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {WorldMoves} from "../src/WorldMoves.sol";

/// @notice Deploys WorldMoves — the event-only move-commit contract for
///         three.ws real-time worlds. No constructor args, no owner, nothing
///         to configure post-deploy.
///
/// Run (BSC testnet, dry-run simulation — no --broadcast):
///   forge script script/DeployWorldMoves.s.sol:DeployWorldMoves \
///     --rpc-url $BSC_TESTNET_RPC_URL -vvvv
///
/// Run (BSC testnet, real deploy):
///   forge script script/DeployWorldMoves.s.sol:DeployWorldMoves \
///     --rpc-url $BSC_TESTNET_RPC_URL \
///     --private-key $DEPLOYER_PK \
///     --broadcast
contract DeployWorldMoves is Script {
    function run() external returns (WorldMoves worldMoves) {
        vm.startBroadcast();
        worldMoves = new WorldMoves();
        vm.stopBroadcast();

        console.log("WorldMoves:", address(worldMoves));
        console.log("COORD_MIN: ", worldMoves.COORD_MIN());
        console.log("COORD_MAX: ", worldMoves.COORD_MAX());
    }
}
