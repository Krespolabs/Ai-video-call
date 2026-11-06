// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GreenfieldVault} from "../src/GreenfieldVault.sol";
import {MockCrossChain, MockPermissionHub, MockGnfdAccessControl} from "../test/mocks/MockGreenfield.sol";

/// @notice LOCAL/TEST-ONLY harness: deploys `MockCrossChain` +
///         `MockPermissionHub` + `MockGnfdAccessControl` (the same faithful
///         mocks `test/GreenfieldVault.t.sol`'s 34-test suite already
///         validates against the real interfaces) plus `GreenfieldVault`
///         wired to them, on a local anvil chain. NEVER use against a real
///         network — `DeployGreenfieldVault.s.sol` (the real script) points
///         at the actual, already-deployed Greenfield hubs.
///
///         Exists because a real end-to-end `buy() -> createPolicy ->
///         PolicyGranted` proof needs a seller who already owns a real
///         Greenfield-mirrored object with `ROLE_CREATE` grantable to the
///         vault — which itself needs a funded Greenfield account (the same
///         root-cause blocker documented across prompts 07/09/10/13/14/18 in
///         PROGRESS.md). This script lets prompt 11 (unlock API) and 13
///         (e2e proof) exercise the REAL contract bytecode, REAL event logs,
///         and REAL two-phase async settlement against a REAL local EVM —
///         everything BUT the real cross-chain relay, which cannot exist
///         without the funded key.
///
/// Run:
///   anvil &
///   forge script script/DeployGreenfieldVaultMocked.s.sol:DeployGreenfieldVaultMocked \
///     --rpc-url http://127.0.0.1:8545 \
///     --private-key <anvil default account #0 key> \
///     --broadcast
contract DeployGreenfieldVaultMocked is Script {
    function run() external returns (GreenfieldVault vault, MockPermissionHub permissionHub, MockCrossChain crossChain, MockGnfdAccessControl objectAccessControl) {
        uint256 relayFee = vm.envOr("MOCK_RELAY_FEE", uint256(1e14)); // 0.0001 native token
        uint256 minAckRelayFee = vm.envOr("MOCK_MIN_ACK_RELAY_FEE", uint256(1e14));

        vm.startBroadcast();
        crossChain = new MockCrossChain(relayFee, minAckRelayFee);
        permissionHub = new MockPermissionHub(crossChain);
        objectAccessControl = new MockGnfdAccessControl();
        vault = new GreenfieldVault(address(permissionHub), address(crossChain), address(objectAccessControl));
        vm.stopBroadcast();

        console.log("GreenfieldVault (mocked hubs):", address(vault));
        console.log("MockPermissionHub:            ", address(permissionHub));
        console.log("MockCrossChain:                ", address(crossChain));
        console.log("MockGnfdAccessControl:         ", address(objectAccessControl));
        console.log("relayFee + minAckRelayFee:     ", relayFee + minAckRelayFee);
    }
}
