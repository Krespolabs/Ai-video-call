// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentPayments} from "../src/AgentPayments.sol";

/// @notice Deploys the AgentPayments engine (EVM port of pump_agent_payments).
///
/// The owner is the protocol/global buyback authority — set it to the platform
/// multisig in production, not a hot EOA. Defaults to the broadcasting deployer
/// when AGENT_PAYMENTS_OWNER is unset.
///
/// Run (testnet):
///   forge script script/DeployAgentPayments.s.sol:DeployAgentPayments \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --private-key $DEPLOYER_PK \
///     --broadcast --verify
///
/// Run (mainnet, per chain): swap --rpc-url for the target chain's RPC.
contract DeployAgentPayments is Script {
    function run() external returns (AgentPayments agentPayments) {
        address owner = vm.envOr("AGENT_PAYMENTS_OWNER", msg.sender);

        vm.startBroadcast();
        agentPayments = new AgentPayments(owner);
        vm.stopBroadcast();

        console.log("AgentPayments:", address(agentPayments));
        console.log("Owner:        ", owner);
        console.log("");
        console.log("Next: allow-list swap routers via setRouterAllowed(router, true),");
        console.log("then set this address in agent-payments-sdk/src/evm/addresses.ts");
    }
}
