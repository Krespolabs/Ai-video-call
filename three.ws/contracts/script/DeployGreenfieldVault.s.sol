// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GreenfieldVault} from "../src/GreenfieldVault.sol";

/// @notice Deploys GreenfieldVault against the REAL, already-deployed Greenfield
///         cross-chain hubs for the target network — never a fresh mock/hub
///         deployment. Addresses default from `bnb-chain/greenfield-contracts`
///         (verified against `master` on 2026-07-08; mainnet cross-checked
///         against `prompts/bnb-chain/00-CONTEXT.md`'s bytecode-verified list)
///         and can be overridden via env for a future hub migration:
///
///           GREENFIELD_PERMISSION_HUB, GREENFIELD_CROSS_CHAIN, GREENFIELD_OBJECT_HUB
///
/// Run (BSC testnet, dry-run simulation — no --broadcast):
///   forge script script/DeployGreenfieldVault.s.sol:DeployGreenfieldVault \
///     --rpc-url $BSC_TESTNET_RPC_URL -vvvv
///
/// Run (BSC testnet, real deploy):
///   forge script script/DeployGreenfieldVault.s.sol:DeployGreenfieldVault \
///     --rpc-url $BSC_TESTNET_RPC_URL \
///     --private-key $DEPLOYER_PK \
///     --broadcast
contract DeployGreenfieldVault is Script {
    // Mainnet (56) — bytecode-verified 2026-07-07, prompts/bnb-chain/00-CONTEXT.md.
    address internal constant PERMISSION_HUB_MAINNET = 0xe1776006dBE9B60d9eA38C0dDb80b41f2657acE8;
    address internal constant CROSS_CHAIN_MAINNET = 0x77e719b714be09F70D484AB81F70D02B0E182f7d;
    address internal constant OBJECT_HUB_MAINNET = 0x634eB9c438b8378bbdd8D0e10970Ec88db0b4d0f;

    // Testnet (97) — bnb-chain/greenfield-contracts README "Contract Entrypoint".
    address internal constant PERMISSION_HUB_TESTNET = 0x25E1eeDb5CaBf288210B132321FBB2d90b4174ad;
    address internal constant CROSS_CHAIN_TESTNET = 0xa5B2c9194131A4E0BFaCbF9E5D6722c873159cb7;
    address internal constant OBJECT_HUB_TESTNET = 0x1b059D8481dEe299713F18601fB539D066553e39;

    function run() external returns (GreenfieldVault vault) {
        (address permissionHub, address crossChain, address objectHub) = _hubsForChain(block.chainid);

        permissionHub = vm.envOr("GREENFIELD_PERMISSION_HUB", permissionHub);
        crossChain = vm.envOr("GREENFIELD_CROSS_CHAIN", crossChain);
        objectHub = vm.envOr("GREENFIELD_OBJECT_HUB", objectHub);

        vm.startBroadcast();
        vault = new GreenfieldVault(permissionHub, crossChain, objectHub);
        vm.stopBroadcast();

        console.log("GreenfieldVault:  ", address(vault));
        console.log("PermissionHub:    ", permissionHub);
        console.log("CrossChain:       ", crossChain);
        console.log("ObjectHub (ACL):  ", objectHub);
        console.log("Chain id:         ", block.chainid);
        console.log("");
        console.log("Next: sellers must grantRole(ROLE_CREATE, vaultAddress, expiry) on");
        console.log("ObjectHub for their mirrored object before list() will accept it.");
    }

    function _hubsForChain(uint256 chainId)
        internal
        pure
        returns (address permissionHub, address crossChain, address objectHub)
    {
        if (chainId == 56) {
            return (PERMISSION_HUB_MAINNET, CROSS_CHAIN_MAINNET, OBJECT_HUB_MAINNET);
        }
        if (chainId == 97) {
            return (PERMISSION_HUB_TESTNET, CROSS_CHAIN_TESTNET, OBJECT_HUB_TESTNET);
        }
        revert("GreenfieldVault: no known Greenfield hub addresses for this chain id");
    }
}
