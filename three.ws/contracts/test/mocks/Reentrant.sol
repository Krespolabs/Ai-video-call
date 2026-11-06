// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GreenfieldVault} from "../../src/GreenfieldVault.sol";

/// @notice Generic reentrancy-attack harness: acts as buyer/seller against
///         `GreenfieldVault` and, on receiving a refund/payout, attempts one
///         armed reentrant call back into the vault. Used to prove
///         `nonReentrant` blocks cross-function reentrancy (e.g. a `buy()`
///         refund trying to trigger a second `buy()`), not merely that
///         checks-effects-interactions happens to leave nothing to steal.
contract Reentrant {
    GreenfieldVault public immutable vault;

    bytes private _reentryCalldata;
    uint256 private _reentryValue;
    bool private _armed;

    bool public reentryAttempted;
    bool public reentryOk;
    bytes public reentryReturnData;

    constructor(GreenfieldVault _vault) {
        vault = _vault;
    }

    function arm(bytes calldata data, uint256 value) external {
        _reentryCalldata = data;
        _reentryValue = value;
        _armed = true;
    }

    receive() external payable {
        if (_armed) {
            _armed = false;
            reentryAttempted = true;
            (bool ok, bytes memory ret) = address(vault).call{value: _reentryValue}(_reentryCalldata);
            reentryOk = ok;
            reentryReturnData = ret;
        }
    }

    function doList(bytes32 objectId, uint256 price) external {
        vault.list(objectId, price, address(this));
    }

    function doBuy(bytes32 objectId, bytes calldata policyData) external payable returns (uint256) {
        return vault.buy{value: msg.value}(objectId, policyData);
    }

    function doWithdraw() external {
        vault.withdraw();
    }

    function doRevoke(uint256 saleId) external payable {
        vault.revoke{value: msg.value}(saleId);
    }
}
