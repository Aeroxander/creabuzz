// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice A stand-in for a passkey smart account that sends several calls as one approved action (the plan's section 6, item 6):
/// every call is made by this contract, so for the Launcher this contract is the founder.
contract BatchAccount {
    /// @notice Make every call in order; any failure reverts all of them.
    function execute(address[] calldata targets, bytes[] calldata calls) external {
        for (uint256 i; i < targets.length; ++i) {
            (bool ok, bytes memory ret) = targets[i].call(calls[i]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
